"""
Record Linkage Script
=====================
Matches clients across two groups of Excel files using:
  - Exact KEY matching
  - Probabilistic name + postcode matching (Splink / DuckDB)

SETUP
-----
1. pip install splink pandas openpyxl rapidfuzz
2. Edit the CONFIG section below to match your file paths and column names.
3. Run: python record_linkage.py
"""

import re
import pandas as pd
from splink import DuckDBAPI, Linker, SettingsCreator, block_on
import splink.comparison_library as cl

# =============================================================================
# CONFIG — Edit this section to match your files
# =============================================================================

# --- File paths --------------------------------------------------------------
GROUP_A_FILES = [
    r"GBS Client.xlsx",   # First file for Group A
    r"GBS WIN.xlsx",   # Second file for Group A
]

GROUP_B_FILES = [
    r"GGB Client.xlsx",   # First file for Group B
    r"GGB WIN.xlsx",   # Second file for Group B
]

# --- Column name mapping (set to None if column doesn't exist) ---------------
# Map your actual column names to the standard names used by the script.

GROUP_A_COLUMNS = {
    "key":      "DUNS",          # Shared key column (set None if absent)
    "name":     "Client_Name",  # Client name column
    "postcode": "Postal_Code",     # Postcode column
}

GROUP_B_COLUMNS = {
    "key":      "DUNS",          # Shared key column (set None if absent)
    "name":     "Client_Name",  # Client name column
    "postcode": "Postal_Code",     # Postcode column
}

# --- Matching thresholds -----------------------------------------------------
# Splink produces a match probability between 0 and 1.
# Pairs above HIGH are auto-accepted; below LOW are discarded; between = review.
THRESHOLD_HIGH = 0.95       # Auto-accept above this
THRESHOLD_LOW  = 0.40       # Discard below this (middle band flagged for review)

# Minimum Jaro-Winkler name similarity for a pair to auto-accept.
# Pairs scoring below this are demoted to Review even if Splink score is high.
# 0.80 = names must be at least 80% similar. Raise to be stricter.
MIN_NAME_SIMILARITY = 0.80

# Minimum name similarity for Review band — discard pairs below this entirely.
# Prevents postcode-only matches from cluttering the review list.
MIN_NAME_SIMILARITY_REVIEW = 0.50

# --- Output ------------------------------------------------------------------
OUTPUT_FILE = "matched_clients.xlsx"

# =============================================================================
# STEP 1 — Load & combine files
# =============================================================================

def load_group(files, col_map, group_label):
    frames = []
    for path in files:
        # Read everything as str to prevent numeric key columns loading as float
        df = pd.read_excel(path, dtype=str)
        df.columns = df.columns.str.strip()

        rename = {}
        for std_name, actual_name in col_map.items():
            if actual_name and actual_name in df.columns:
                rename[actual_name] = std_name

        df = df.rename(columns=rename)

        # Keep only standard columns that exist
        keep = [c for c in ["key", "name", "postcode"] if c in df.columns]
        df = df[keep].copy()

        # Retain all original columns for output context
        original = pd.read_excel(path, dtype=str)
        original.columns = original.columns.str.strip()
        df = pd.concat([df, original.drop(
            columns=[v for v in col_map.values() if v and v in original.columns],
            errors="ignore"
        )], axis=1)

        df["_source_file"] = path
        frames.append(df)

    combined = pd.concat(frames, ignore_index=True)
    combined["_group"] = group_label
    return combined


# =============================================================================
# STEP 2 — Standardise / clean
# =============================================================================

def clean_name(s):
    """
    Cleans both personal and company names:
      - Strips personal titles (MR, MRS, DR, etc.)
      - Strips company suffixes (LTD, PLC, LLP, etc.)
      - Removes punctuation and extra whitespace
    """
    if pd.isna(s):
        return None
    s = str(s).upper().strip()

    # Company suffixes
    company_suffixes = [
        r"\bLIMITED\b", r"\bLTD\b", r"\bPLC\b", r"\bLLP\b",
        r"\bINC\b", r"\bINCORPORATED\b", r"\bCORPORATION\b",
        r"\bCORP\b", r"\bGROUP\b", r"\bHOLDINGS\b", r"\bPARTNERSHIP\b",
        r"\bTRADING\b", r"\bENTERPRISES\b", r"\bSERVICES\b",
        r"\bSOLUTIONS\b", r"\bCONSULTING\b", r"\b^CO\b",
    ]
    for pattern in company_suffixes:
        s = re.sub(pattern, "", s)

    # Personal titles
    personal_titles = [
        r"\bMR\b", r"\bMRS\b", r"\bMS\b", r"\bMISS\b", r"\bDR\b",
        r"\bPROF\b", r"\bREV\b", r"\bSIR\b", r"\bLADY\b", r"\bLORD\b",
    ]
    for pattern in personal_titles:
        s = re.sub(pattern, "", s)

    # Remove punctuation, collapse whitespace
    s = re.sub(r"[^\w\s]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s or None


def name_token_sort(s):
    """
    Token-sorted name for blocking: 'SMITH JOHN' and 'JOHN SMITH' → 'JOHN SMITH'.
    Used as a blocking key only — fuzzy scoring uses the unsorted clean name.
    """
    if pd.isna(s):
        return None
    return " ".join(sorted(s.split()))


def clean_postcode(s):
    if pd.isna(s):
        return None
    s = re.sub(r"\s+", "", str(s).upper().strip())
    return s or None


def postcode_sector(pc):
    """Extract sector: 'SW1A1AA' → 'SW1A1'  (everything except last 2 chars)"""
    if pd.isna(pc) or len(pc) < 3:
        return None
    return pc[:-2]


def clean_numeric_key(s):
    """Normalise numeric keys: strip whitespace, remove trailing .0 from float conversion."""
    if pd.isna(s):
        return None
    s = str(s).strip()
    # Remove float suffix: "12345.0" → "12345"
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


# =============================================================================
# STEP 3 — Exact KEY matching
# =============================================================================

def exact_key_match(df_a, df_b):
    if "key_clean" not in df_a.columns or "key_clean" not in df_b.columns:
        return pd.DataFrame(), df_a, df_b

    a_keyed = df_a[df_a["key_clean"].notna()].copy()
    b_keyed = df_b[df_b["key_clean"].notna()].copy()

    matched = a_keyed.merge(b_keyed, on="key_clean", suffixes=("_A", "_B"))
    matched["match_type"] = "Exact KEY"
    matched["match_score"] = 1.0

    matched_ids_a = matched["_id_A"].unique()
    matched_ids_b = matched["_id_B"].unique()

    remaining_a = df_a[~df_a["_id"].isin(matched_ids_a)].copy()
    remaining_b = df_b[~df_b["_id"].isin(matched_ids_b)].copy()

    print(f"  Exact KEY matches:      {len(matched):>8,}")
    return matched, remaining_a, remaining_b


# =============================================================================
# STEP 4 — Probabilistic matching with Splink
# =============================================================================

def probabilistic_match(df_a, df_b, prefix_a="A", prefix_b="B"):
    if df_a.empty or df_b.empty:
        return pd.DataFrame()

    # Splink needs a unique 'unique_id' column
    df_a = df_a.copy()
    df_b = df_b.copy()
    df_a["unique_id"] = f"{prefix_a}_" + df_a["_id"].astype(str)
    df_b["unique_id"] = f"{prefix_b}_" + df_b["_id"].astype(str)

    # Build comparison columns list (only use columns that exist)
    comparisons = []
    blocking_rules = []

    has_name = "name_clean" in df_a.columns and df_a["name_clean"].notna().any()
    has_pc   = "postcode_clean" in df_a.columns and df_a["postcode_clean"].notna().any()

    if has_name:
        comparisons.append(
            cl.JaroWinklerAtThresholds("name_clean", [0.95, 0.88, 0.80])
        )
    if has_pc:
        comparisons.append(
            cl.ExactMatch("postcode_clean").configure(term_frequency_adjustments=True)
        )
        comparisons.append(
            cl.ExactMatch("postcode_sector")
        )

    if not comparisons:
        print("  No usable columns for probabilistic matching — skipping.")
        return pd.DataFrame()

    # Blocking rules: only compare records within same postcode sector or same name prefix
    if has_pc:
        blocking_rules.append(block_on("postcode_sector"))
    if has_name:
        blocking_rules.append(block_on("substr(name_clean, 1, 4)"))
        blocking_rules.append(block_on("name_sorted"))  # catches swapped first/last name

    settings = SettingsCreator(
        link_type="link_only",
        comparisons=comparisons,
        blocking_rules_to_generate_predictions=blocking_rules,
        em_convergence=0.001,
    )

    # Only pass Splink the columns it needs — extra columns cause DuckDB binder errors
    splink_cols = ["unique_id"]
    for col in ["name_clean", "name_sorted", "postcode_clean", "postcode_sector"]:
        if col in df_a.columns:
            splink_cols.append(col)
    df_a_splink = df_a[splink_cols].copy()
    df_b_splink = df_b[splink_cols].copy()

    db_api = DuckDBAPI()
    linker = Linker([df_a_splink, df_b_splink], settings, db_api=db_api)

    print("  Training Splink model...")
    linker.training.estimate_u_using_random_sampling(max_pairs=1_000_000)

    if has_name:
        try:
            # First pass — train on postcode sector blocks
            linker.training.estimate_parameters_using_expectation_maximisation(
                block_on("postcode_sector") if has_pc else block_on("substr(name_clean, 1, 4)")
            )
            # Second pass — train on name prefix blocks to improve name u-values
            linker.training.estimate_parameters_using_expectation_maximisation(
                block_on("substr(name_clean, 1, 3)")
            )
        except Exception:
            pass  # Fall back to u-only estimates


    print("  Generating predictions...")
    predictions = linker.inference.predict(threshold_match_probability=THRESHOLD_LOW)
    df_pred = predictions.as_pandas_dataframe()

    print(f"  Candidate pairs found:  {len(df_pred):>8,}")
    return df_pred


# =============================================================================
# STEP 5 — Format output
# =============================================================================

def format_predictions(df_pred, df_a, df_b, label_a="A", label_b="B"):
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

        # Name similarity guard — prevents postcode-only matches inflating results
        from rapidfuzz.distance import JaroWinkler
        name_a_clean = rec_a.get("name_clean")
        name_b_clean = rec_b.get("name_clean")
        name_sim = (JaroWinkler.similarity(name_a_clean, name_b_clean)
                    if name_a_clean and name_b_clean else 0.0)

        band = "Auto-Accept" if score >= THRESHOLD_HIGH else "Review"
        if band == "Auto-Accept" and name_sim < MIN_NAME_SIMILARITY:
            band = "Review"

        # Discard review-band pairs where names are too dissimilar
        # (likely postcode-only matches with no real name evidence)
        if band == "Review" and name_sim < MIN_NAME_SIMILARITY_REVIEW:
            continue

        rows.append({
            "match_score":      score,
            "match_band":       band,
            "name_similarity":  round(name_sim, 4),
            f"name_{label_a}":           rec_a.get("name"),
            f"name_{label_b}":           rec_b.get("name"),
            f"postcode_{label_a}":       rec_a.get("postcode"),
            f"postcode_{label_b}":       rec_b.get("postcode"),
            f"key_{label_a}":            rec_a.get("key"),
            f"key_{label_b}":            rec_b.get("key"),
            f"source_file_{label_a}":    rec_a.get("_source_file"),
            f"source_file_{label_b}":    rec_b.get("_source_file"),
        })

    df_out = pd.DataFrame(rows).sort_values("match_score", ascending=False)
    auto    = df_out[df_out["match_band"] == "Auto-Accept"]
    review  = df_out[df_out["match_band"] == "Review"]
    return auto, review


# =============================================================================
# STEP 5b — Intra-group duplicate detection
# =============================================================================

def intra_group_duplicates(df_group, group_label):
    """Find duplicates between the two source files within a single group."""
    source_files = df_group["_source_file"].unique()
    if len(source_files) < 2:
        print(f"  Group {group_label}: only one source file, skipping intra-group check.")
        return pd.DataFrame(), pd.DataFrame(), pd.DataFrame()

    df_file1 = df_group[df_group["_source_file"] == source_files[0]].copy()
    df_file2 = df_group[df_group["_source_file"] == source_files[1]].copy()

    print(f"  Group {group_label}: {source_files[0]} ({len(df_file1):,}) "
          f"vs {source_files[1]} ({len(df_file2):,})")

    # Assign unique IDs for this intra-group comparison
    df_file1 = df_file1.reset_index(drop=True)
    df_file2 = df_file2.reset_index(drop=True)
    df_file1["_id"] = df_file1.index
    df_file2["_id"] = df_file2.index
    df_file1["unique_id"] = f"{group_label}1_" + df_file1["_id"].astype(str)
    df_file2["unique_id"] = f"{group_label}2_" + df_file2["_id"].astype(str)

    # Exact KEY matching
    exact, remaining_1, remaining_2 = exact_key_match(df_file1, df_file2)

    # Probabilistic matching on remainder
    df_pred = probabilistic_match(
        remaining_1, remaining_2,
        prefix_a=f"{group_label}1", prefix_b=f"{group_label}2"
    )
    auto, review = format_predictions(
        df_pred, remaining_1, remaining_2,
        label_a="File1", label_b="File2"
    )

    return exact, auto, review


# =============================================================================
# STEP 6 — Write Excel output
# =============================================================================

def write_output(exact_matches, auto_matches, review_matches,
                 intra_a_results=None, intra_b_results=None):
    with pd.ExcelWriter(OUTPUT_FILE, engine="openpyxl") as writer:

        def write_sheet(df, name, desc):
            if df.empty:
                pd.DataFrame({"Info": [f"No {desc} found."]}).to_excel(
                    writer, sheet_name=name, index=False
                )
            else:
                df.to_excel(writer, sheet_name=name, index=False)
            print(f"  Sheet '{name}': {len(df):,} rows")

        # Combine cross-group results into a single sheet
        # Normalise exact match columns to align with probabilistic output
        combined_parts = []
        if not exact_matches.empty:
            exact_norm = exact_matches.rename(columns={
                "_source_file_A": "source_file_A",
                "_source_file_B": "source_file_B",
            })
            exact_norm["match_type"] = "Exact KEY"
            exact_norm["match_band"] = "Exact KEY"
            if "name_similarity" not in exact_norm.columns:
                exact_norm["name_similarity"] = None
            combined_parts.append(exact_norm)
        if not auto_matches.empty:
            auto_copy = auto_matches.copy()
            auto_copy["match_type"] = "Auto-Accept"
            combined_parts.append(auto_copy)
        if not review_matches.empty:
            review_copy = review_matches.copy()
            review_copy["match_type"] = "Review"
            combined_parts.append(review_copy)

        # Select consistent columns in display order
        display_cols = ["match_type", "match_score", "name_similarity",
                        "name_A", "name_B", "postcode_A", "postcode_B",
                        "key_A", "key_B", "source_file_A", "source_file_B"]
        if combined_parts:
            cross_group = pd.concat(combined_parts, ignore_index=True)
            # Keep only columns that exist
            display_cols = [c for c in display_cols if c in cross_group.columns]
            cross_group = cross_group[display_cols]
        else:
            cross_group = pd.DataFrame()
        write_sheet(cross_group, "Cross-Group Matches", "cross-group matches")

        # Intra-group duplicate sheets
        intra_a_total = 0
        intra_b_total = 0
        if intra_a_results:
            exact_a, auto_a, review_a = intra_a_results
            intra_a_combined = pd.concat([exact_a, auto_a, review_a], ignore_index=True)
            intra_a_total = len(intra_a_combined)
            write_sheet(intra_a_combined, "Group A Duplicates",
                        "intra-group A duplicates")
        if intra_b_results:
            exact_b, auto_b, review_b = intra_b_results
            intra_b_combined = pd.concat([exact_b, auto_b, review_b], ignore_index=True)
            intra_b_total = len(intra_b_combined)
            write_sheet(intra_b_combined, "Group B Duplicates",
                        "intra-group B duplicates")

        # Summary sheet
        summary_rows = [
            ("Cross-Group: Exact KEY Matches", len(exact_matches), "KEY match"),
            ("Cross-Group: Auto-Accept", len(auto_matches), f"Score ≥ {THRESHOLD_HIGH}"),
            ("Cross-Group: Review Required", len(review_matches),
             f"Score {THRESHOLD_LOW}–{THRESHOLD_HIGH}"),
            ("Cross-Group: Total", len(exact_matches) + len(auto_matches) + len(review_matches),
             ""),
            ("Group A Intra-Duplicates", intra_a_total, "Between files in Group A"),
            ("Group B Intra-Duplicates", intra_b_total, "Between files in Group B"),
        ]
        summary = pd.DataFrame(summary_rows, columns=["Category", "Count", "Threshold"])
        summary.to_excel(writer, sheet_name="Summary", index=False)

    print(f"\n✅  Output written to: {OUTPUT_FILE}")


# =============================================================================
# MAIN
# =============================================================================

def main():
    print("=" * 60)
    print("Record Linkage Script")
    print("=" * 60)

    # Load
    print("\n[1/7] Loading files...")
    df_a = load_group(GROUP_A_FILES, GROUP_A_COLUMNS, "A")
    df_b = load_group(GROUP_B_FILES, GROUP_B_COLUMNS, "B")
    print(f"  Group A records: {len(df_a):,}")
    print(f"  Group B records: {len(df_b):,}")

    # Standardise
    print("\n[2/7] Standardising data...")
    df_a = standardise(df_a).reset_index(drop=True)
    df_b = standardise(df_b).reset_index(drop=True)
    df_a["_id"] = df_a.index
    df_b["_id"] = df_b.index
    df_a["unique_id"] = "A_" + df_a["_id"].astype(str)
    df_b["unique_id"] = "B_" + df_b["_id"].astype(str)

    # Exact KEY match
    print("\n[3/7] Running exact KEY matching...")
    exact_matches, remaining_a, remaining_b = exact_key_match(df_a, df_b)
    print(f"  Remaining A: {len(remaining_a):,}  |  Remaining B: {len(remaining_b):,}")

    # Probabilistic match on remainder
    print("\n[4/7] Running probabilistic matching (Splink)...")
    df_pred = probabilistic_match(remaining_a, remaining_b)
    auto_matches, review_matches = format_predictions(df_pred, remaining_a, remaining_b)
    print(f"  Auto-accept: {len(auto_matches):,}  |  For review: {len(review_matches):,}")

    # Intra-group duplicate detection
    print("\n[5/7] Finding intra-group duplicates in Group A...")
    intra_a_results = intra_group_duplicates(df_a, "A")
    intra_a_exact, intra_a_auto, intra_a_review = intra_a_results
    intra_a_total = len(intra_a_exact) + len(intra_a_auto) + len(intra_a_review)
    print(f"  Group A intra-duplicates: {intra_a_total:,}")

    print("\n[6/7] Finding intra-group duplicates in Group B...")
    intra_b_results = intra_group_duplicates(df_b, "B")
    intra_b_exact, intra_b_auto, intra_b_review = intra_b_results
    intra_b_total = len(intra_b_exact) + len(intra_b_auto) + len(intra_b_review)
    print(f"  Group B intra-duplicates: {intra_b_total:,}")

    # Write output
    print("\n[7/7] Writing output...")
    write_output(exact_matches, auto_matches, review_matches,
                 intra_a_results=intra_a_results,
                 intra_b_results=intra_b_results)

    print("\nDone.")
    print(f"  Cross-group exact KEY:        {len(exact_matches):>8,}")
    print(f"  Cross-group auto-accepts:     {len(auto_matches):>8,}")
    print(f"  Cross-group manual review:    {len(review_matches):>8,}")
    print(f"  Group A intra-duplicates:     {intra_a_total:>8,}")
    print(f"  Group B intra-duplicates:     {intra_b_total:>8,}")
    print("=" * 60)


if __name__ == "__main__":
    main()
