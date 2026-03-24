# -*- coding: utf-8 -*-
"""
Record Linkage Script
=====================
Matches clients across two groups of Excel files using:
  - Exact KEY matching
  - Probabilistic name + postcode matching (Splink / DuckDB)

SETUP
-----
1. pip install splink pandas openpyxl rapidfuzz duckdb
2. Edit the CONFIG section below to match your file paths and column names.
3. Run: python record_linkage.py

POWER BI USAGE
--------------
1. In Power BI Desktop: Home > Get Data > Other > Python script
2. Paste this entire script into the editor
3. IMPORTANT: Change all file paths below to ABSOLUTE paths, e.g.:
       r"C:\\Users\\YourName\\Documents\\GBS Client.xlsx"
   Power BI runs scripts from a temp folder, so relative paths will NOT work.
4. Make sure Power BI's Python path (File > Options > Python scripting) points
   to the environment where you installed the packages above.
5. Click OK -- the script produces a table called 'dataset' that Power BI
   will show in the Navigator. Click Load.
"""

import os
import re
import sys
import pandas as pd

# Quiet mode: suppresses print() in Power BI to avoid stdout buffering hangs
_quiet = False

def _log(msg=""):
    if not _quiet:
        print(msg)

# ---------------------------------------------------------------------------
# Dependency check -- surfaces clear errors in Power BI instead of crashing
# ---------------------------------------------------------------------------
_missing = []
for _pkg in ["splink", "openpyxl", "rapidfuzz", "duckdb"]:
    try:
        __import__(_pkg)
    except ImportError:
        _missing.append(_pkg)

if _missing:
    # In Power BI this becomes a visible table instead of a silent failure
    dataset = pd.DataFrame({
        "Error": [
            f"Missing Python packages: {', '.join(_missing)}. "
            f"Install them with:  pip install {' '.join(_missing)}"
        ]
    })
    # Stop execution here -- the rest of the script would fail anyway
    raise SystemExit(0) if __name__ == "__main__" else None
else:
    from splink import DuckDBAPI, Linker, SettingsCreator, block_on
    import splink.comparison_library as cl

# =============================================================================
# CONFIG -- Edit this section to match your files
# =============================================================================

# --- File paths --------------------------------------------------------------
# POWER BI USERS: You MUST use full absolute paths here, e.g.:
#   r"C:\Users\YourName\Documents\GBS Client.xlsx"
GROUP_A_FILES = [
    r"GBS Client.xlsx",   # First file for Group A
    r"GBS WIN.xlsx",      # Second file for Group A
]

GROUP_B_FILES = [
    r"GGB Client.xlsx",   # First file for Group B
    r"GGB WIN.xlsx",      # Second file for Group B
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

# --- Output ------------------------------------------------------------------
OUTPUT_FILE = "matched_clients.xlsx"

# =============================================================================
# STEP 1 -- Load & combine files
# =============================================================================

def load_group(files, col_map, group_label):
    frames = []
    for path in files:
        if not os.path.isfile(path):
            raise FileNotFoundError(
                f"Cannot find file: {path}\n"
                f"Current working directory: {os.getcwd()}\n"
                f"Hint: Use absolute paths (e.g. r\"C:\\Users\\You\\Documents\\{os.path.basename(path)}\")"
            )
        # Read once as str to prevent numeric key columns loading as float
        original = pd.read_excel(path, dtype=str)
        original.columns = original.columns.str.strip()

        rename = {}
        for std_name, actual_name in col_map.items():
            if actual_name and actual_name in original.columns:
                rename[actual_name] = std_name

        df = original.copy()
        df = df.rename(columns=rename)

        # Standard columns that the script uses internally
        std_cols = [c for c in ["key", "name", "postcode"] if c in df.columns]

        # Keep standard columns + any extra original columns (for output context)
        mapped_originals = [v for v in col_map.values() if v and v in original.columns]
        extra_cols = [c for c in original.columns if c not in mapped_originals]
        df = df[std_cols + extra_cols].copy()

        df["_source_file"] = path
        frames.append(df)

    combined = pd.concat(frames, ignore_index=True)
    combined["_group"] = group_label
    return combined


# =============================================================================
# STEP 2 -- Standardise / clean
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
    Token-sorted name for blocking: 'SMITH JOHN' and 'JOHN SMITH' -> 'JOHN SMITH'.
    Used as a blocking key only -- fuzzy scoring uses the unsorted clean name.
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
    """Extract sector: 'SW1A1AA' -> 'SW1A1'  (everything except last 2 chars)"""
    if pd.isna(pc) or len(pc) < 3:
        return None
    return pc[:-2]


def clean_numeric_key(s):
    """Normalise numeric keys: strip whitespace, remove trailing .0 from float conversion."""
    if pd.isna(s):
        return None
    s = str(s).strip()
    # Remove float suffix: "12345.0" -> "12345"
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
# STEP 3 -- Exact KEY matching
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

    _log(f"  Exact KEY matches:      {len(matched):>8,}")
    return matched, remaining_a, remaining_b


# =============================================================================
# STEP 4 -- Probabilistic matching with Splink
# =============================================================================

def probabilistic_match(df_a, df_b):
    if df_a.empty or df_b.empty:
        return pd.DataFrame()

    # Splink needs a unique 'unique_id' column
    df_a = df_a.copy()
    df_b = df_b.copy()
    df_a["unique_id"] = "A_" + df_a["_id"].astype(str)
    df_b["unique_id"] = "B_" + df_b["_id"].astype(str)

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
        _log("  No usable columns for probabilistic matching -- skipping.")
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

    # Only pass Splink the columns it needs -- extra columns cause DuckDB binder errors
    splink_cols = ["unique_id"]
    for col in ["name_clean", "name_sorted", "postcode_clean", "postcode_sector"]:
        if col in df_a.columns:
            splink_cols.append(col)
    df_a_splink = df_a[splink_cols].copy()
    df_b_splink = df_b[splink_cols].copy()

    # DuckDB can fail in Power BI's sandboxed environment. Try an in-memory
    # database first; if that fails, fall back to a temp file-based database.
    try:
        db_api = DuckDBAPI()
    except Exception:
        import tempfile
        _tmp_db = os.path.join(tempfile.gettempdir(), "splink_linkage.duckdb")
        _log(f"  In-memory DuckDB failed; using temp file: {_tmp_db}")
        try:
            db_api = DuckDBAPI(connection=_tmp_db)
        except Exception as exc:
            _log(f"  DuckDB init failed: {exc}")
            return pd.DataFrame()

    try:
        linker = Linker([df_a_splink, df_b_splink], settings, db_api=db_api)
    except Exception as exc:
        _log(f"  Splink Linker init failed: {exc}")
        return pd.DataFrame()

    _log("  Training Splink model...")
    # Fewer pairs in Power BI to avoid timeout in the sandboxed environment
    _max_pairs = 200_000 if _quiet else 1_000_000
    linker.training.estimate_u_using_random_sampling(max_pairs=_max_pairs)

    if has_name:
        try:
            # First pass -- train on postcode sector blocks
            linker.training.estimate_parameters_using_expectation_maximisation(
                block_on("postcode_sector") if has_pc else block_on("substr(name_clean, 1, 4)")
            )
            # Second pass -- train on name prefix blocks to improve name u-values
            linker.training.estimate_parameters_using_expectation_maximisation(
                block_on("substr(name_clean, 1, 3)")
            )
        except Exception:
            pass  # Fall back to u-only estimates

    _log("  Generating predictions...")
    predictions = linker.inference.predict(threshold_match_probability=THRESHOLD_LOW)
    df_pred = predictions.as_pandas_dataframe()

    _log(f"  Candidate pairs found:  {len(df_pred):>8,}")
    return df_pred


# =============================================================================
# STEP 5 -- Format output
# =============================================================================

def format_predictions(df_pred, df_a, df_b):
    if df_pred.empty:
        return pd.DataFrame(), pd.DataFrame()

    from rapidfuzz.distance import JaroWinkler

    a_lookup = df_a.set_index("unique_id")
    b_lookup = df_b.set_index("unique_id")

    rows = []
    for _, row in df_pred.iterrows():
        uid_a = row.get("unique_id_l") or row.get("unique_id_1")
        uid_b = row.get("unique_id_r") or row.get("unique_id_2")
        score = round(row["match_probability"], 4)

        rec_a = a_lookup.loc[uid_a] if uid_a in a_lookup.index else pd.Series()
        rec_b = b_lookup.loc[uid_b] if uid_b in b_lookup.index else pd.Series()

        # Require exact postcode match -- discard pairs with only similar postcodes
        pc_a = rec_a.get("postcode_clean")
        pc_b = rec_b.get("postcode_clean")
        if pc_a and pc_b and pc_a != pc_b:
            continue

        # Name similarity guard -- discard pairs where names are too dissimilar
        # regardless of Splink score (prevents postcode-only matches)
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
            "source_file_A":    rec_a.get("_source_file"),
            "source_file_B":    rec_b.get("_source_file"),
        })

    df_out = pd.DataFrame(rows).sort_values("match_score", ascending=False)
    auto    = df_out[df_out["match_band"] == "Auto-Accept"]
    review  = df_out[df_out["match_band"] == "Review"]
    return auto, review


# =============================================================================
# STEP 6 -- Write Excel output
# =============================================================================

def write_output(exact_matches, auto_matches, review_matches):
    with pd.ExcelWriter(OUTPUT_FILE, engine="openpyxl") as writer:

        def write_sheet(df, name, desc):
            if df.empty:
                pd.DataFrame({"Info": [f"No {desc} found."]}).to_excel(
                    writer, sheet_name=name, index=False
                )
            else:
                df.to_excel(writer, sheet_name=name, index=False)
            _log(f"  Sheet '{name}': {len(df):,} rows")

        write_sheet(exact_matches, "Exact KEY Matches",  "exact key matches")
        write_sheet(auto_matches,  "Auto-Accept Matches", "high-confidence matches")
        write_sheet(review_matches,"Review Required",     "medium-confidence matches")

        # Summary sheet
        summary = pd.DataFrame({
            "Category":    ["Exact KEY Matches", "Auto-Accept (Probabilistic)",
                            "Review Required",   "Total Matched"],
            "Count":       [len(exact_matches),  len(auto_matches),
                            len(review_matches),
                            len(exact_matches) + len(auto_matches) + len(review_matches)],
            "Threshold":   [f"KEY match",
                            f"Score >= {THRESHOLD_HIGH}",
                            f"Score {THRESHOLD_LOW}-{THRESHOLD_HIGH}",
                            ""]
        })
        summary.to_excel(writer, sheet_name="Summary", index=False)

    _log(f"\nOK:  Output written to: {OUTPUT_FILE}")


# =============================================================================
# MAIN
# =============================================================================

def main(skip_file_output=False):
    _log("=" * 60)
    _log("Record Linkage Script")
    _log("=" * 60)

    # Load
    _log("\n[1/5] Loading files...")
    df_a = load_group(GROUP_A_FILES, GROUP_A_COLUMNS, "A")
    df_b = load_group(GROUP_B_FILES, GROUP_B_COLUMNS, "B")
    _log(f"  Group A records: {len(df_a):,}")
    _log(f"  Group B records: {len(df_b):,}")

    # Standardise
    _log("\n[2/5] Standardising data...")
    df_a = standardise(df_a).reset_index(drop=True)
    df_b = standardise(df_b).reset_index(drop=True)
    df_a["_id"] = df_a.index
    df_b["_id"] = df_b.index
    df_a["unique_id"] = "A_" + df_a["_id"].astype(str)
    df_b["unique_id"] = "B_" + df_b["_id"].astype(str)

    # Exact KEY match
    _log("\n[3/5] Running exact KEY matching...")
    exact_matches, remaining_a, remaining_b = exact_key_match(df_a, df_b)
    _log(f"  Remaining A: {len(remaining_a):,}  |  Remaining B: {len(remaining_b):,}")

    # Probabilistic match on remainder
    _log("\n[4/5] Running probabilistic matching (Splink)...")
    df_pred = probabilistic_match(remaining_a, remaining_b)
    auto_matches, review_matches = format_predictions(df_pred, remaining_a, remaining_b)
    _log(f"  Auto-accept: {len(auto_matches):,}  |  For review: {len(review_matches):,}")

    # Write output (skipped in Power BI -- unnecessary file I/O)
    if not skip_file_output:
        _log("\n[5/5] Writing output...")
        write_output(exact_matches, auto_matches, review_matches)
    else:
        _log("\n[5/5] Skipping file output (Power BI mode).")

    _log("\nDone.")
    _log(f"  Exact KEY matches:            {len(exact_matches):>8,}")
    _log(f"  Probabilistic auto-accepts:   {len(auto_matches):>8,}")
    _log(f"  Flagged for manual review:    {len(review_matches):>8,}")
    _log("=" * 60)

    return exact_matches, auto_matches, review_matches


def main_powerbi():
    """
    Entry point for Power BI / Power Query.
    Returns a single combined DataFrame that Power Query can pick up.
    Errors are returned as a DataFrame so they appear in the preview
    instead of the cryptic "section1/query1 does not exist" message.
    """
    global _quiet
    _quiet = True
    try:
        # Validate files exist before doing any work
        all_files = GROUP_A_FILES + GROUP_B_FILES
        missing = [f for f in all_files if not os.path.isfile(f)]
        if missing:
            return pd.DataFrame({
                "Error": [f"File not found: {f}"] for f in missing
            } if len(missing) == 1 else {
                "Error": [
                    f"Files not found ({len(missing)} missing). "
                    f"Working directory: {os.getcwd()}. "
                    f"Missing: {', '.join(missing)}. "
                    f"Hint: Use absolute paths like r\"C:\\Users\\You\\Documents\\filename.xlsx\""
                ]
            })

        exact_matches, auto_matches, review_matches = main(skip_file_output=True)

        # Tag each result set and combine into one table for Power Query
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

    except FileNotFoundError as e:
        return pd.DataFrame({"Error": [str(e)]})
    except Exception as e:
        import traceback
        return pd.DataFrame({
            "Error": [str(e)],
            "Details": [traceback.format_exc()],
            "Hint": [
                "Common fixes: (1) Use absolute file paths, "
                "(2) Install packages: pip install splink pandas openpyxl rapidfuzz duckdb, "
                "(3) Check Python path in Power BI Options > Python scripting"
            ],
        })


# ---------------------------------------------------------------------------
# When run from the command line, use main() as before.
# When run inside Power BI, call main_powerbi() to get a single DataFrame.
# ---------------------------------------------------------------------------

def _running_in_powerbi():
    """Detect if we're running inside Power BI's Python sandbox."""
    # Power BI runs scripts from a temp directory and sets no terminal
    return not sys.stdout.isatty()

if _running_in_powerbi():
    # Power BI: quiet mode, no file output, return DataFrame
    dataset = main_powerbi()
elif __name__ == "__main__":
    # Command-line: full output (prints + Excel file)
    main()
else:
    # Imported as module: also use Power BI path
    dataset = main_powerbi()
