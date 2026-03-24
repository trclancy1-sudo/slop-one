# -*- coding: utf-8 -*-
"""
Record Linkage -- Power BI version
===================================
Paste this script into a Power BI "Run Python script" transformation step.

SETUP
-----
1. pip install splink pandas rapidfuzz duckdb

2. In Power BI, load your four Excel files as separate queries:
     GBS_Client, GBS_WIN, GGB_Client, GGB_WIN
   (The exact query names don't matter -- just update the CONFIG below.)

3. Select ALL FOUR queries in the Power Query editor, then:
     Transform > Run Python script
   Paste this entire script. Power BI will make each selected query
   available as a DataFrame variable whose name matches the query name.

4. The script outputs a single table called 'dataset'.

COLUMN MAPPING
--------------
Edit the CONFIG section to map your actual column names to the standard
names (key, name, postcode) used by the matching logic.
"""

import os
import re
import tempfile
import pandas as pd

# =============================================================================
# CONFIG -- edit this section
# =============================================================================

GROUP_A_QUERY_NAMES = ["GBS_Client", "GBS_WIN"]
GROUP_B_QUERY_NAMES = ["GGB_Client", "GGB_WIN"]

GROUP_A_COLUMNS = {
    "key":      "DUNS",
    "name":     "Client_Name",
    "postcode": "Postal_Code",
}
GROUP_B_COLUMNS = {
    "key":      "DUNS",
    "name":     "Client_Name",
    "postcode": "Postal_Code",
}

THRESHOLD_HIGH      = 0.95
THRESHOLD_LOW       = 0.40
MIN_NAME_SIMILARITY = 0.80


# =============================================================================
# ALL LOGIC IN ONE FUNCTION -- so 'dataset' can be assigned at top level
# =============================================================================

def _run(pbi_frames):
    """
    Main entry point.  pbi_frames is a dict of {query_name: DataFrame}
    captured at the top level where Power BI injects them.
    Returns a single DataFrame.
    """

    # --- Dependency check ---------------------------------------------------
    missing = []
    for pkg in ["splink", "rapidfuzz", "duckdb"]:
        try:
            __import__(pkg)
        except ImportError:
            missing.append(pkg)
    if missing:
        return pd.DataFrame({
            "Error": [
                f"Missing Python packages: {', '.join(missing)}. "
                f"Install them with:  pip install {' '.join(missing)}"
            ]
        })

    from splink import DuckDBAPI, Linker, SettingsCreator, block_on
    import splink.comparison_library as cl
    from rapidfuzz.distance import JaroWinkler

    # --- Validate Power BI query DataFrames --------------------------------
    for qn in GROUP_A_QUERY_NAMES + GROUP_B_QUERY_NAMES:
        if qn not in pbi_frames:
            return pd.DataFrame({
                "Error": [
                    f"Query '{qn}' not found. "
                    "Make sure you selected it before running the Python script step. "
                    f"Found queries: {list(pbi_frames.keys())}"
                ]
            })

    # --- Helpers -----------------------------------------------------------
    def collect_queries(query_names, col_map, group_label):
        frames = []
        for qname in query_names:
            df = pbi_frames[qname].copy()
            df.columns = df.columns.str.strip()
            for c in df.columns:
                df[c] = df[c].astype(str).replace("nan", pd.NA)
            rename = {}
            for std_name, actual_name in col_map.items():
                if actual_name and actual_name in df.columns:
                    rename[actual_name] = std_name
            df = df.rename(columns=rename)
            df["_source_query"] = qname
            frames.append(df)
        combined = pd.concat(frames, ignore_index=True)
        combined["_group"] = group_label
        return combined

    def clean_name(s):
        if pd.isna(s):
            return None
        s = str(s).upper().strip()
        for pat in [
            r"\bLIMITED\b", r"\bLTD\b", r"\bPLC\b", r"\bLLP\b",
            r"\bINC\b", r"\bINCORPORATED\b", r"\bCORPORATION\b",
            r"\bCORP\b", r"\bGROUP\b", r"\bHOLDINGS\b", r"\bPARTNERSHIP\b",
            r"\bTRADING\b", r"\bENTERPRISES\b", r"\bSERVICES\b",
            r"\bSOLUTIONS\b", r"\bCONSULTING\b", r"\b^CO\b",
            r"\bMR\b", r"\bMRS\b", r"\bMS\b", r"\bMISS\b", r"\bDR\b",
            r"\bPROF\b", r"\bREV\b", r"\bSIR\b", r"\bLADY\b", r"\bLORD\b",
        ]:
            s = re.sub(pat, "", s)
        s = re.sub(r"[^\w\s]", "", s)
        s = re.sub(r"\s+", " ", s).strip()
        return s or None

    def name_token_sort(s):
        if pd.isna(s):
            return None
        return " ".join(sorted(s.split()))

    def clean_postcode(s):
        if pd.isna(s):
            return None
        s = re.sub(r"\s+", "", str(s).upper().strip())
        return s or None

    def postcode_sector(pc):
        if pd.isna(pc) or len(pc) < 3:
            return None
        return pc[:-2]

    def clean_numeric_key(s):
        if pd.isna(s):
            return None
        s = str(s).strip()
        if re.match(r"^\d+\.0$", s):
            s = s[:-2]
        return s or None

    def standardise(df):
        if "name" in df.columns:
            df["name_clean"] = df["name"].apply(clean_name)
            df["name_sorted"] = df["name_clean"].apply(name_token_sort)
        if "postcode" in df.columns:
            df["postcode_clean"] = df["postcode"].apply(clean_postcode)
            df["postcode_sector"] = df["postcode_clean"].apply(postcode_sector)
        if "key" in df.columns:
            df["key_clean"] = df["key"].apply(clean_numeric_key)
        return df

    def exact_key_match(df_a, df_b):
        if "key_clean" not in df_a.columns or "key_clean" not in df_b.columns:
            return pd.DataFrame(), df_a, df_b
        a_keyed = df_a[df_a["key_clean"].notna()].copy()
        b_keyed = df_b[df_b["key_clean"].notna()].copy()
        matched = a_keyed.merge(b_keyed, on="key_clean", suffixes=("_A", "_B"))
        matched["match_type"] = "Exact KEY"
        matched["match_score"] = 1.0
        remaining_a = df_a[~df_a["_id"].isin(matched["_id_A"].unique())].copy()
        remaining_b = df_b[~df_b["_id"].isin(matched["_id_B"].unique())].copy()
        return matched, remaining_a, remaining_b

    def probabilistic_match(df_a, df_b):
        if df_a.empty or df_b.empty:
            return pd.DataFrame()

        df_a = df_a.copy()
        df_b = df_b.copy()
        df_a["unique_id"] = "A_" + df_a["_id"].astype(str)
        df_b["unique_id"] = "B_" + df_b["_id"].astype(str)

        comparisons = []
        blocking_rules = []
        has_name = "name_clean" in df_a.columns and df_a["name_clean"].notna().any()
        has_pc = "postcode_clean" in df_a.columns and df_a["postcode_clean"].notna().any()

        if has_name:
            comparisons.append(cl.JaroWinklerAtThresholds("name_clean", [0.95, 0.88, 0.80]))
        if has_pc:
            comparisons.append(cl.ExactMatch("postcode_clean").configure(term_frequency_adjustments=True))
            comparisons.append(cl.ExactMatch("postcode_sector"))

        if not comparisons:
            return pd.DataFrame()

        if has_pc:
            blocking_rules.append(block_on("postcode_sector"))
        if has_name:
            blocking_rules.append(block_on("substr(name_clean, 1, 4)"))
            blocking_rules.append(block_on("name_sorted"))

        settings = SettingsCreator(
            link_type="link_only",
            comparisons=comparisons,
            blocking_rules_to_generate_predictions=blocking_rules,
            em_convergence=0.001,
        )

        splink_cols = ["unique_id"]
        for col in ["name_clean", "name_sorted", "postcode_clean", "postcode_sector"]:
            if col in df_a.columns:
                splink_cols.append(col)

        try:
            db_api = DuckDBAPI()
        except Exception:
            tmp = os.path.join(tempfile.gettempdir(), "splink_linkage.duckdb")
            try:
                db_api = DuckDBAPI(connection=tmp)
            except Exception:
                return pd.DataFrame()

        try:
            linker = Linker(
                [df_a[splink_cols].copy(), df_b[splink_cols].copy()],
                settings, db_api=db_api,
            )
        except Exception:
            return pd.DataFrame()

        linker.training.estimate_u_using_random_sampling(max_pairs=200_000)

        if has_name:
            try:
                linker.training.estimate_parameters_using_expectation_maximisation(
                    block_on("postcode_sector") if has_pc else block_on("substr(name_clean, 1, 4)")
                )
                linker.training.estimate_parameters_using_expectation_maximisation(
                    block_on("substr(name_clean, 1, 3)")
                )
            except Exception:
                pass

        predictions = linker.inference.predict(threshold_match_probability=THRESHOLD_LOW)
        return predictions.as_pandas_dataframe()

    def format_predictions(df_pred, df_a, df_b):
        if df_pred.empty:
            return pd.DataFrame(), pd.DataFrame()

        a_lookup = df_a.set_index("unique_id")
        b_lookup = df_b.set_index("unique_id")

        rows = []
        for _, row in df_pred.iterrows():
            uid_a = row.get("unique_id_l") or row.get("unique_id_1")
            uid_b = row.get("unique_id_r") or row.get("unique_id_2")
            score = round(row["match_probability"], 4)

            rec_a = a_lookup.loc[uid_a] if uid_a in a_lookup.index else pd.Series()
            rec_b = b_lookup.loc[uid_b] if uid_b in b_lookup.index else pd.Series()

            pc_a = rec_a.get("postcode_clean")
            pc_b = rec_b.get("postcode_clean")
            if pc_a and pc_b and pc_a != pc_b:
                continue

            name_a_clean = rec_a.get("name_clean")
            name_b_clean = rec_b.get("name_clean")
            name_sim = JaroWinkler.similarity(
                str(name_a_clean or ""), str(name_b_clean or "")
            )
            if name_a_clean and name_b_clean and name_sim < MIN_NAME_SIMILARITY:
                continue

            band = "Auto-Accept" if score >= THRESHOLD_HIGH else "Review"
            rows.append({
                "match_score":      score,
                "match_band":       band,
                "name_similarity":  round(name_sim, 4),
                "name_A":           rec_a.get("name"),
                "name_B":           rec_b.get("name"),
                "postcode_A":       rec_a.get("postcode"),
                "postcode_B":       rec_b.get("postcode"),
                "key_A":            rec_a.get("key"),
                "key_B":            rec_b.get("key"),
                "source_query_A":   rec_a.get("_source_query"),
                "source_query_B":   rec_b.get("_source_query"),
            })

        df_out = pd.DataFrame(rows).sort_values("match_score", ascending=False)
        auto = df_out[df_out["match_band"] == "Auto-Accept"]
        review = df_out[df_out["match_band"] == "Review"]
        return auto, review

    # --- Run ---------------------------------------------------------------
    df_a = collect_queries(GROUP_A_QUERY_NAMES, GROUP_A_COLUMNS, "A")
    df_b = collect_queries(GROUP_B_QUERY_NAMES, GROUP_B_COLUMNS, "B")

    df_a = standardise(df_a).reset_index(drop=True)
    df_b = standardise(df_b).reset_index(drop=True)
    df_a["_id"] = df_a.index
    df_b["_id"] = df_b.index
    df_a["unique_id"] = "A_" + df_a["_id"].astype(str)
    df_b["unique_id"] = "B_" + df_b["_id"].astype(str)

    exact_matches, remaining_a, remaining_b = exact_key_match(df_a, df_b)

    df_pred = probabilistic_match(remaining_a, remaining_b)
    auto_matches, review_matches = format_predictions(df_pred, remaining_a, remaining_b)

    parts = []
    if not exact_matches.empty:
        em = exact_matches.copy()
        em["match_type"] = "Exact KEY"
        em["match_band"] = "Exact KEY"
        parts.append(em)
    if not auto_matches.empty:
        am = auto_matches.copy()
        am["match_type"] = "Probabilistic"
        parts.append(am)
    if not review_matches.empty:
        rm = review_matches.copy()
        rm["match_type"] = "Probabilistic"
        parts.append(rm)

    if parts:
        return pd.concat(parts, ignore_index=True)
    else:
        return pd.DataFrame({"Info": ["No matches found."]})


# =============================================================================
# TOP-LEVEL: reference Power BI DataFrames by their LITERAL names.
# Dynamic lookup (globals, locals, eval) does not work in Power BI's exec().
# You MUST use the actual variable names that match your Power BI query names.
#
# IMPORTANT: If your Power BI queries have different names, change BOTH the
# variable references below AND the GROUP_A/B_QUERY_NAMES lists above.
# =============================================================================
try:
    _pbi_frames = {
        "GBS_Client": GBS_Client,
        "GBS_WIN":    GBS_WIN,
        "GGB_Client": GGB_Client,
        "GGB_WIN":    GGB_WIN,
    }
    dataset = _run(_pbi_frames)
except NameError as _e:
    dataset = pd.DataFrame({
        "Error": [
            f"Query not found: {_e}. "
            "Check that your Power BI query names match the variable names "
            "in this script (line ~350). Select all queries before running."
        ],
    })
except Exception as _e:
    import traceback
    dataset = pd.DataFrame({
        "Error": [str(_e)],
        "Details": [traceback.format_exc()],
    })
