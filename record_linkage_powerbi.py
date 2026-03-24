# -*- coding: utf-8 -*-
"""
Record Linkage -- Power BI version
===================================
Use this script as a "Run Python script" transformation step.

SETUP IN POWER BI
------------------
1. pip install splink pandas rapidfuzz duckdb

2. Load your Excel files as four separate queries in Power Query:
     GBS_Client, GBS_WIN, GGB_Client, GGB_WIN

3. To each query, add TWO custom columns (Add Column > Custom Column):
     - "source_group" with value "A" or "B"
     - "source_query" with the query name (e.g. "GBS_Client")

     Group A queries get source_group = "A"
     Group B queries get source_group = "B"

4. Append all four queries into ONE query:
     Home > Append Queries > Append Queries as New
     Select all four queries.

5. Select the new combined query, then:
     Transform > Run Python script
   Paste this entire script.

6. The combined data arrives as a variable called 'dataset'.
   The script uses source_group to split it back into A and B.

COLUMN MAPPING
--------------
Edit the CONFIG section below to map your column names.
"""

import os
import re
import tempfile
import pandas as pd


# =============================================================================
# CONFIG -- edit this section
# =============================================================================

# Column mapping: map your actual column names to the standard names.
# The "source_group" and "source_query" columns are the ones you added in step 3.
COLUMN_MAP = {
    "key":           "DUNS",          # Shared key column (set None if absent)
    "name":          "Client_Name",   # Client name column
    "postcode":      "Postal_Code",   # Postcode column
    "source_group":  "source_group",  # The custom column you added ("A" or "B")
    "source_query":  "source_query",  # The custom column with the query name
}

# Thresholds
THRESHOLD_HIGH      = 0.95
THRESHOLD_LOW       = 0.40
MIN_NAME_SIMILARITY = 0.80


# =============================================================================
# ALL LOGIC IN ONE FUNCTION
# =============================================================================

def _run(input_df):
    """
    Takes a single combined DataFrame (with a source_group column to
    distinguish Group A from Group B) and returns the matched results.
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

    # --- Validate input -----------------------------------------------------
    if input_df is None or input_df.empty:
        return pd.DataFrame({
            "Error": ["No data received. Make sure you appended all four "
                      "queries and selected the combined query before running."]
        })

    input_df = input_df.copy()
    input_df.columns = input_df.columns.str.strip()

    # Rename columns to standard names
    rename = {}
    for std_name, actual_name in COLUMN_MAP.items():
        if actual_name and actual_name in input_df.columns:
            rename[actual_name] = std_name
    input_df = input_df.rename(columns=rename)

    if "source_group" not in input_df.columns:
        return pd.DataFrame({
            "Error": [
                "Column 'source_group' not found. "
                "Add a Custom Column to each query with value \"A\" or \"B\" "
                "before appending. "
                f"Available columns: {list(input_df.columns)}"
            ]
        })

    # Split into Group A and Group B
    df_a = input_df[input_df["source_group"].str.upper().str.strip() == "A"].copy()
    df_b = input_df[input_df["source_group"].str.upper().str.strip() == "B"].copy()

    if df_a.empty or df_b.empty:
        return pd.DataFrame({
            "Error": [
                f"Group A has {len(df_a)} rows, Group B has {len(df_b)} rows. "
                "Both groups need data. Check your source_group column values."
            ]
        })

    # --- Helpers -----------------------------------------------------------
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

    # --- Standardise -------------------------------------------------------
    df_a = standardise(df_a).reset_index(drop=True)
    df_b = standardise(df_b).reset_index(drop=True)
    df_a["_id"] = df_a.index
    df_b["_id"] = df_b.index
    df_a["unique_id"] = "A_" + df_a["_id"].astype(str)
    df_b["unique_id"] = "B_" + df_b["_id"].astype(str)

    # --- Exact KEY match ---------------------------------------------------
    exact_matches = pd.DataFrame()
    remaining_a, remaining_b = df_a, df_b

    if "key_clean" in df_a.columns and "key_clean" in df_b.columns:
        a_keyed = df_a[df_a["key_clean"].notna()].copy()
        b_keyed = df_b[df_b["key_clean"].notna()].copy()
        exact_matches = a_keyed.merge(b_keyed, on="key_clean", suffixes=("_A", "_B"))
        exact_matches["match_type"] = "Exact KEY"
        exact_matches["match_score"] = 1.0
        remaining_a = df_a[~df_a["_id"].isin(exact_matches["_id_A"].unique())].copy()
        remaining_b = df_b[~df_b["_id"].isin(exact_matches["_id_B"].unique())].copy()

    # --- Probabilistic match -----------------------------------------------
    df_pred = pd.DataFrame()
    if not remaining_a.empty and not remaining_b.empty:
        ra = remaining_a.copy()
        rb = remaining_b.copy()

        comparisons = []
        blocking_rules = []
        has_name = "name_clean" in ra.columns and ra["name_clean"].notna().any()
        has_pc = "postcode_clean" in ra.columns and ra["postcode_clean"].notna().any()

        if has_name:
            comparisons.append(cl.JaroWinklerAtThresholds("name_clean", [0.95, 0.88, 0.80]))
        if has_pc:
            comparisons.append(cl.ExactMatch("postcode_clean").configure(term_frequency_adjustments=True))
            comparisons.append(cl.ExactMatch("postcode_sector"))

        if comparisons:
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
                if col in ra.columns:
                    splink_cols.append(col)

            try:
                db_api = DuckDBAPI()
            except Exception:
                tmp = os.path.join(tempfile.gettempdir(), "splink_linkage.duckdb")
                db_api = DuckDBAPI(connection=tmp)

            linker = Linker(
                [ra[splink_cols].copy(), rb[splink_cols].copy()],
                settings, db_api=db_api,
            )

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
            df_pred = predictions.as_pandas_dataframe()

    # --- Format predictions ------------------------------------------------
    auto_matches = pd.DataFrame()
    review_matches = pd.DataFrame()

    if not df_pred.empty:
        a_lookup = remaining_a.set_index("unique_id")
        b_lookup = remaining_b.set_index("unique_id")

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
                "source_query_A":   rec_a.get("source_query"),
                "source_query_B":   rec_b.get("source_query"),
            })

        if rows:
            df_out = pd.DataFrame(rows).sort_values("match_score", ascending=False)
            auto_matches = df_out[df_out["match_band"] == "Auto-Accept"]
            review_matches = df_out[df_out["match_band"] == "Review"]

    # --- Combine results ---------------------------------------------------
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
# Power BI passes the input data as 'dataset'. Run matching & reassign it.
# =============================================================================
try:
    dataset = _run(dataset)
except Exception as _e:
    import traceback
    dataset = pd.DataFrame({
        "Error": [str(_e)],
        "Details": [traceback.format_exc()],
    })
