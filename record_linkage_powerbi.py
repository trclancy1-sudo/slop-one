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

3. Append all four queries into ONE query:
     Home > Append Queries > Append Queries as New
   This creates a "Source" column automatically with the query name.

4. Select the appended query, then:
     Transform > Run Python script
   Paste this entire script.

5. The combined data arrives as 'dataset'. The script uses the Source
   column to split it into Group A (GBS) and Group B (GGB).

COLUMN MAPPING
--------------
Edit the CONFIG section below. Group A and Group B can have different
column names.
"""

import os
import re
import tempfile
import pandas as pd


# =============================================================================
# CONFIG -- edit this section
# =============================================================================

# Column mapping PER GROUP.
# Group A (GBS) and Group B (GGB) may have different column names.
GROUP_A_COLUMNS = {
    "key":      "DUNS",
    "name":     "Client_Name",
    "postcode": "Postal_Code",
}
GROUP_B_COLUMNS = {
    "key":      "ClientRef",       # was GGBClientKey, renamed in Power Query
    "name":     "Client_Name",
    "postcode": "Postal_Code",
}

# The "Source" column created by Append Queries -- contains the query name.
SOURCE_COLUMN = "Source"

# Which Source values belong to Group A vs Group B.
GROUP_A_SOURCES = ["GBS_Client", "GBS_WIN"]
GROUP_B_SOURCES = ["GGB_Client", "GGB_WIN"]

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

    if SOURCE_COLUMN not in input_df.columns:
        return pd.DataFrame({
            "Error": [
                f"Column '{SOURCE_COLUMN}' not found. "
                "This column is created automatically by Append Queries. "
                f"Available columns: {list(input_df.columns)}"
            ]
        })

    # Split into Group A and Group B using the Source column
    raw_a = input_df[input_df[SOURCE_COLUMN].isin(GROUP_A_SOURCES)].copy()
    raw_b = input_df[input_df[SOURCE_COLUMN].isin(GROUP_B_SOURCES)].copy()

    if raw_a.empty or raw_b.empty:
        return pd.DataFrame({
            "Error": [
                f"Group A has {len(raw_a)} rows, Group B has {len(raw_b)} rows. "
                f"Source column values found: {input_df[SOURCE_COLUMN].unique().tolist()}. "
                f"Expected A: {GROUP_A_SOURCES}, B: {GROUP_B_SOURCES}."
            ]
        })

    # Apply per-group column mapping
    def apply_col_map(df, col_map):
        rename = {}
        for std_name, actual_name in col_map.items():
            if actual_name and actual_name in df.columns:
                rename[actual_name] = std_name
        return df.rename(columns=rename)

    df_a = apply_col_map(raw_a, GROUP_A_COLUMNS)
    df_b = apply_col_map(raw_b, GROUP_B_COLUMNS)

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
            # With 300k rows, tight blocking is essential to keep pairs manageable.
            # Only compare records that share postcode sector AND first 3 chars of name.
            if has_pc and has_name:
                blocking_rules.append(block_on("postcode_sector", "substr(name_clean, 1, 3)"))
                blocking_rules.append(block_on("postcode_sector", "name_sorted"))
            elif has_pc:
                blocking_rules.append(block_on("postcode_sector"))
            elif has_name:
                blocking_rules.append(block_on("substr(name_clean, 1, 4)"))
                blocking_rules.append(block_on("name_sorted"))

            settings = SettingsCreator(
                link_type="link_only",
                comparisons=comparisons,
                blocking_rules_to_generate_predictions=blocking_rules,
                em_convergence=0.01,     # relaxed from 0.001 — faster convergence
                max_iterations=10,        # cap EM iterations
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

            # For large datasets, train on a sample for speed then predict on all.
            MAX_TRAIN_ROWS = 30_000
            if len(ra) > MAX_TRAIN_ROWS or len(rb) > MAX_TRAIN_ROWS:
                ra_sample = ra.sample(n=min(MAX_TRAIN_ROWS, len(ra)), random_state=42)
                rb_sample = rb.sample(n=min(MAX_TRAIN_ROWS, len(rb)), random_state=42)
            else:
                ra_sample, rb_sample = ra, rb

            # Train model on sample
            linker_train = Linker(
                [ra_sample[splink_cols].copy(), rb_sample[splink_cols].copy()],
                settings, db_api=db_api,
            )
            linker_train.training.estimate_u_using_random_sampling(max_pairs=50_000)

            if has_name:
                try:
                    linker_train.training.estimate_parameters_using_expectation_maximisation(
                        block_on("postcode_sector") if has_pc else block_on("substr(name_clean, 1, 4)")
                    )
                    linker_train.training.estimate_parameters_using_expectation_maximisation(
                        block_on("substr(name_clean, 1, 3)")
                    )
                except Exception:
                    pass

            # Predict on the full dataset using the trained settings
            trained_settings = linker_train._settings_obj.as_dict()
            linker_full = Linker(
                [ra[splink_cols].copy(), rb[splink_cols].copy()],
                trained_settings, db_api=db_api,
            )

            predictions = linker_full.inference.predict(threshold_match_probability=THRESHOLD_LOW)
            df_pred = predictions.as_pandas_dataframe()

    # --- Format predictions ------------------------------------------------
    auto_matches = pd.DataFrame()
    review_matches = pd.DataFrame()

    if not df_pred.empty:
        a_lookup = remaining_a.set_index("unique_id")
        b_lookup = remaining_b.set_index("unique_id")

        # Normalise Splink's uid column names (varies by version)
        uid_l = "unique_id_l" if "unique_id_l" in df_pred.columns else "unique_id_1"
        uid_r = "unique_id_r" if "unique_id_r" in df_pred.columns else "unique_id_2"

        # Vectorised join: attach A and B columns to predictions in bulk
        df_pred = df_pred.rename(columns={uid_l: "uid_a", uid_r: "uid_b"})
        df_pred["match_score"] = df_pred["match_probability"].round(4)

        a_cols = {c: f"{c}_A" for c in ["name", "name_clean", "postcode", "postcode_clean", "key", SOURCE_COLUMN]}
        b_cols = {c: f"{c}_B" for c in ["name", "name_clean", "postcode", "postcode_clean", "key", SOURCE_COLUMN]}

        df_out = (
            df_pred
            .merge(a_lookup.rename(columns=a_cols), left_on="uid_a", right_index=True, how="left")
            .merge(b_lookup.rename(columns=b_cols), left_on="uid_b", right_index=True, how="left")
        )

        # Filter: drop mismatched postcodes (vectorised)
        pc_a = df_out["postcode_clean_A"]
        pc_b = df_out["postcode_clean_B"]
        both_have_pc = pc_a.notna() & pc_b.notna()
        df_out = df_out[~(both_have_pc & (pc_a != pc_b))]

        # Name similarity (vectorised via list comp — much faster than iterrows)
        name_a_vals = df_out["name_clean_A"].fillna("").astype(str).tolist()
        name_b_vals = df_out["name_clean_B"].fillna("").astype(str).tolist()
        df_out["name_similarity"] = [
            round(JaroWinkler.similarity(a, b), 4)
            for a, b in zip(name_a_vals, name_b_vals)
        ]

        # Filter: drop low name similarity where both names exist
        both_have_name = df_out["name_clean_A"].notna() & df_out["name_clean_B"].notna()
        df_out = df_out[~(both_have_name & (df_out["name_similarity"] < MIN_NAME_SIMILARITY))]

        # Classify matches
        df_out["match_band"] = df_out["match_score"].apply(
            lambda s: "Auto-Accept" if s >= THRESHOLD_HIGH else "Review"
        )

        # Select and rename output columns
        keep = [
            "match_score", "match_band", "name_similarity",
            "name_A", "name_B", "postcode_A", "postcode_B",
            "key_A", "key_B",
            f"{SOURCE_COLUMN}_A", f"{SOURCE_COLUMN}_B",
        ]
        df_out = df_out[[c for c in keep if c in df_out.columns]]
        df_out = df_out.sort_values("match_score", ascending=False)

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
