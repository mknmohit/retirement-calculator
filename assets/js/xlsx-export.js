/*!
 * Retirement Calculator — Excel (XLSX) export module
 *
 * Produces a multi-sheet workbook with LIVE FORMULAS that recalculate when
 * the user edits the Inputs sheet inside Excel / Google Sheets.
 *
 * Convention (mirrors the /xlsx-author skill):
 *   • Inputs tab holds every editable parameter (no hardcodes in calc cells).
 *   • Calculation cells are all formulas referencing named ranges from Inputs.
 *   • Workbook-level LAMBDAs encapsulate the FY 2025-26 New Regime tax
 *     calculation (slab → 80TTB → 87A rebate → surcharge w/ marginal relief
 *     → 4% cess) and the lifestyle / annuity rate lookups.
 *   • Checks tab surfaces TRUE/FALSE balance checks for every strategy.
 *
 * Requires window.XLSX (SheetJS Community Edition). Loaded together with
 * the library by app.js's exportXLSX() handler.
 *
 * Exposes: window.RetirementXLSX.build(inputs) → SheetJS workbook
 */
(function () {
  'use strict';

  /* ────────────────────────────────────────────────────────────────────────
     INPUT LAYOUT — single source of truth for the Inputs sheet.
     Each row either declares a section header or an editable input with a
     workbook-level named range.  ALL projection formulas reference these
     names, so inserting rows in the Inputs sheet inside Excel will NOT
     break the calculations (Excel updates name references automatically).
     ──────────────────────────────────────────────────────────────────────── */
  const INPUT_LAYOUT = [
    { kind: 'banner', text: 'Retirement Calculator — Your Numbers (editable)' },
    { kind: 'banner', text: 'Change any number in column B. Every other sheet updates by itself.' },
    { kind: 'blank' },

    { kind: 'section', label: "Your money & how it's split" },
    { kind: 'input', name: 'CORPUS',         label: 'Total savings (₹)',                key: 'totalCorpus',         fmt: 'inr',  note: "All the money you have when you start." },
    { kind: 'input', name: 'FD_PCT',         label: 'FD & stock market allocation (%)', key: 'fdPercent',           fmt: 'pct0', note: "% kept safe (bank deposits etc.); the rest goes into the stock market." },
    { kind: 'blank' },

    { kind: 'section', label: 'Growth' },
    { kind: 'input', name: 'FD_RATE',        label: 'Interest on savings (bank/FD) per year (%)', key: 'fdRate',    fmt: 'pct2', note: "Bank deposit / senior scheme; the senior plan locks in 8.2%." },
    { kind: 'input', name: 'EQ_RATE',        label: 'Stock market growth (% per year)', key: 'equityRate',          fmt: 'pct2', note: "India's market has grown ~11–12% a year over 20 years." },
    { kind: 'input', name: 'EQ_VOL',         label: 'How wildly the market swings (%)', key: 'equityVolatility',    fmt: 'pct2', note: "Only used by the luck test; the plain projection ignores it." },
    { kind: 'blank' },

    { kind: 'section', label: 'Rising prices' },
    { kind: 'input', name: 'INFL',           label: 'Inflation per year — how fast prices rise (%)', key: 'inflation',  fmt: 'pct2', note: "Long-term India average is about 6%." },
    { kind: 'input', name: 'HEALTH_INFL',    label: 'Medical inflation per year — how fast medical costs rise (%)', key: 'healthInflation', fmt: 'pct2', note: "Medical costs in India rise about 12–14% a year." },
    { kind: 'blank' },

    { kind: 'section', label: 'About you' },
    { kind: 'input', name: 'START_AGE',      label: 'Your age now',                     key: 'startingAge',         fmt: 'int',  note: "Your age at the start of the plan." },
    { kind: 'input', name: 'IS_SENIOR',      label: 'Age 60 or older? (1=yes, 0=no)',   key: 'isSenior',            fmt: 'bool', note: "1 unlocks senior tax breaks and the senior scheme at 8.2%." },
    { kind: 'input', name: 'SPOUSE',         label: 'Planning as a couple? (1=yes, 0=no)', key: 'spouse',           fmt: 'bool', note: "Splits income across two people; doubles the senior-scheme and tax-free-profit limits." },
    { kind: 'input', name: 'SPOUSE_AGE',     label: 'Spouse age',                       key: 'spouseAge',           fmt: 'int',  note: "Used to check senior-scheme eligibility." },
    { kind: 'blank' },

    { kind: 'section', label: "What you spend & earn (today's ₹)" },
    { kind: 'input', name: 'MONTHLY_EXP',    label: 'Monthly spending (₹)',             key: 'monthlyExpense',      fmt: 'inr',  note: "What you typically spend in a month now." },
    { kind: 'input', name: 'HEALTH_INS',     label: 'Health insurance per year (₹)',    key: 'healthInsuranceAnnual', fmt: 'inr', note: "Today's premium; rises at the medical-cost rate." },
    { kind: 'input', name: 'PENSION',        label: 'Pension or rent per year (₹)',     key: 'pensionAnnual',       fmt: 'inr',  note: "Income from outside your savings." },
    { kind: 'input', name: 'PENSION_INFL_F', label: 'Pension grows with prices? (1=yes, 0=no)', key: 'pensionInflated', fmt: 'bool', note: "1 = rises over time (rent); 0 = fixed forever (most insurance pensions)." },
    { kind: 'input', name: 'OTHER_INC',      label: 'Any other income per year (₹)',    key: 'otherIncome',         fmt: 'inr',  note: "Freelance / consulting; kept flat." },
    { kind: 'blank' },

    { kind: 'section', label: 'Spending changes with age' },
    { kind: 'input', name: 'LIFE_MID',       label: 'Spending at ages 65–75 (×)',       key: 'lifestyleMid',        fmt: 'mult', note: "0.95 = a little less; 1.0 = no change." },
    { kind: 'input', name: 'LIFE_OLD',       label: 'Spending after age 75 (×)',        key: 'lifestyleOld',        fmt: 'mult', note: "1.15 = 15% more for care and help at home." },
    { kind: 'blank' },

    { kind: 'section', label: 'Tax (India 2025-26)' },
    { kind: 'input', name: 'TAX_MODE_FLAT',  label: 'Tax: 1 = flat %, 0 = Indian rules', key: 'taxModeFlat',        fmt: 'bool', note: "1 = use the flat rate below; 0 = full Indian tax rules." },
    { kind: 'input', name: 'FLAT_RATE',      label: 'Flat tax rate (% — only if above = 1)', key: 'flatTaxRate',  fmt: 'pct2', note: "Used only when the tax setting above is 1." },
    { kind: 'input', name: 'LTCG_RATE',      label: 'Tax on stock profit (%)',          key: 'ltcgRate',            fmt: 'pct2', note: "12.5% on long-term stock profit." },
    { kind: 'input', name: 'LTCG_EXEMPT',    label: 'Tax-free stock profit per person (₹)', key: 'ltcgExemption',   fmt: 'inr',  note: "₹1.25 L a year; doubles to ₹2.5 L as a couple." },
    { kind: 'input', name: 'TAX_HARVEST',    label: 'Use the free yearly tax-saver? (1=yes, 0=no)', key: 'taxHarvesting', fmt: 'bool', note: "Each year, sell a little stock and buy it back to use the tax-free limit. No tax, no risk, no real money moves." },
    { kind: 'blank' },

    { kind: 'section', label: 'Goals & timeline' },
    { kind: 'input', name: 'BEQUEST',        label: "Money to leave for family (today's ₹)", key: 'bequestGoal',    fmt: 'inr',  note: "What you'd like to leave behind; 0 = none." },
    { kind: 'input', name: 'MAX_YEARS',      label: 'How many years to plan',           key: 'maxYears',            fmt: 'int',  note: "50 years by default." },
  ];

  const NUM_FMT = {
    inr:  '"₹"#,##0;[Red]"₹"-#,##0;"—"',
    pct2: '0.00',
    pct0: '0',
    int:  '0',
    bool: '0',
    mult: '0.00',
    inrL: '"₹"#,##0;[Red]"₹"-#,##0;"₹"0',  // signed currency
    rate2:'0.00%',
    pctd: '0.0%',
  };

  /* Years reserved on the Life_Events sheet — fixed range so SUMIFS lookups
     stay stable even if user adds/removes events later. */
  const EVENTS_MAX_ROWS = 60;

  /* Tax slab table (FY 2025-26 New Regime), kept as a separate sheet so the
     SLAB_TAX_BASE LAMBDA can be regulatory-future-proof. */
  const SLAB_TABLE = [
    [0,        400000,   0.00],
    [400000,   800000,   0.05],
    [800000,   1200000,  0.10],
    [1200000,  1600000,  0.15],
    [1600000,  2000000,  0.20],
    [2000000,  2400000,  0.25],
    [2400000,  1e15,     0.30],   // 1e15 stands in for +∞
  ];

  /* Annuity rate by age (LIC Jeevan Akshay-VII style, with Return-of-Purchase-Price). */
  const ANNUITY_TABLE = [
    [0,   0.058],
    [60,  0.062],
    [65,  0.065],
    [70,  0.072],
    [75,  0.080],
  ];

  /* SCSS interest rate (fixed sovereign rate). */
  const SCSS_RATE = 0.082;
  /* SWP arbitrage fund rate (FD-equivalent, taxed as equity). */
  const ARB_RATE = 0.065;
  /* SWP liquid bucket rate (sweep / liquid fund). */
  const LIQ_RATE = 0.05;

  /* ────────────────────────────────────────────────────────────────────────
     UTILITIES
     ──────────────────────────────────────────────────────────────────────── */
  function col(n) {
    /* 0-indexed column number → A, B, …, Z, AA, AB, … */
    let s = '';
    n = Math.floor(n);
    while (n >= 0) {
      s = String.fromCharCode(65 + (n % 26)) + s;
      n = Math.floor(n / 26) - 1;
    }
    return s;
  }
  function cellRef(colIdx, rowIdx) { return col(colIdx) + (rowIdx + 1); }

  function fmtForKind(k) {
    if (k === 'inr')  return NUM_FMT.inr;
    if (k === 'pct2') return NUM_FMT.pct2;
    if (k === 'pct0') return NUM_FMT.pct0;
    if (k === 'int')  return NUM_FMT.int;
    if (k === 'bool') return NUM_FMT.bool;
    if (k === 'mult') return NUM_FMT.mult;
    return undefined;
  }

  function n(v, z) {
    if (v === '' || v === undefined || v === null) return { t: 'z' };
    const cell = { t: 'n', v: Number(v) };
    if (z) cell.z = z;
    return cell;
  }
  function s(v) { return { t: 's', v: String(v) }; }
  function f(formula, z) {
    const cell = { t: 'n', f: formula };
    if (z) cell.z = z;
    return cell;
  }
  function fs(formula) { return { t: 's', f: formula }; }
  function fb(formula) { return { t: 'b', f: formula }; }

  /* Make a cell from a 2-D AoA-style entry. Strings, numbers, and { t, v, f, z }
     pass through; primitives become typed cells.  Used by mat2sheet below. */
  function asCell(v) {
    if (v === null || v === undefined || v === '') return { t: 'z' };
    if (typeof v === 'object' && (v.t || v.f)) return v;
    if (typeof v === 'number') return { t: 'n', v };
    if (typeof v === 'boolean') return { t: 'b', v };
    return { t: 's', v: String(v) };
  }

  function aoaToSheet(XLSX, rows) {
    /* Build the sheet manually so we can attach `f` (formula) and `z`
       (number format) per cell — SheetJS aoa_to_sheet strips object cells. */
    const ws = {};
    let maxR = 0, maxC = 0;
    rows.forEach((row, r) => {
      row.forEach((v, c) => {
        const ref = cellRef(c, r);
        ws[ref] = asCell(v);
        if (r > maxR) maxR = r;
        if (c > maxC) maxC = c;
      });
    });
    ws['!ref'] = `A1:${cellRef(maxC, maxR)}`;
    return ws;
  }

  /* ────────────────────────────────────────────────────────────────────────
     INPUTS SHEET — declares editable cells and emits named-range descriptors.
     Returns { sheet, names } so callers can register the names workbook-wide.
     ──────────────────────────────────────────────────────────────────────── */
  function buildInputsSheet(XLSX, inp) {
    const rows = [];
    const names = [];

    rows.push([s('Retirement Calculator — Editable Inputs')]);
    rows.push([s("Edit any value in column B. Every projection sheet recalculates from these named ranges.")]);
    rows.push([s("(Inserting rows is safe — workbook-level named ranges keep formulas pointing to the right cells.)")]);
    rows.push([]);
    rows.push([s('Parameter'), s('Value'), s(''), s('Notes')]);

    for (const item of INPUT_LAYOUT) {
      if (item.kind === 'banner')  continue;                       // already in rows[0..2]
      if (item.kind === 'blank')   { rows.push([]); continue; }
      if (item.kind === 'section') { rows.push([s('── ' + item.label + ' ──')]); continue; }
      // input row
      const z = fmtForKind(item.fmt);
      let v = inp[item.key];
      if (item.key === 'taxModeFlat') v = inp.taxMode === 'flat' ? 1 : 0;
      if (typeof v === 'boolean') v = v ? 1 : 0;
      rows.push([
        s(item.label),
        { t: 'n', v: Number(v) || 0, z },
        s(''),
        s(item.note || ''),
      ]);
      // The row index in the spreadsheet is (rows.length - 1), and the
      // value lives in column B (index 1).
      const rIdx = rows.length - 1;
      names.push({ name: item.name, ref: `Inputs!$B$${rIdx + 1}` });
    }

    const ws = aoaToSheet(XLSX, rows);
    ws['!cols'] = [{ wch: 38 }, { wch: 18 }, { wch: 2 }, { wch: 70 }];
    /* Freeze first 5 rows. */
    ws['!freeze'] = { xSplit: 0, ySplit: 5, topLeftCell: 'A6', activePane: 'bottomLeft' };
    return { sheet: ws, names };
  }

  /* ────────────────────────────────────────────────────────────────────────
     LIFE_EVENTS SHEET — editable list of one-off expenses (year/amount/label).
     The SUMIFS formula in projection sheets references EVENT_YEARS / EVENT_AMTS
     named ranges so users can freely add events up to EVENTS_MAX_ROWS rows.
     ──────────────────────────────────────────────────────────────────────── */
  function buildLifeEventsSheet(XLSX, inp) {
    const rows = [];
    rows.push([s('Life Events (editable)'), s(''), s('')]);
    rows.push([s("Add or remove rows freely up to row " + (EVENTS_MAX_ROWS + 1) + ". Year = years from retirement start, Amount in today's ₹.")]);
    rows.push([]);
    rows.push([s('Year'), s('Amount (today\'s ₹)'), s('Description')]);
    const startR = rows.length;   // first data row index (0-based)
    (inp.events || []).forEach(e => {
      rows.push([n(e.year, NUM_FMT.int), n(e.amount, NUM_FMT.inr), s(e.label || '')]);
    });
    // Pad to EVENTS_MAX_ROWS so the named range size is fixed.
    while (rows.length - startR < EVENTS_MAX_ROWS) rows.push([{ t: 'z' }, { t: 'z' }, { t: 's', v: '' }]);

    const ws = aoaToSheet(XLSX, rows);
    ws['!cols'] = [{ wch: 8 }, { wch: 22 }, { wch: 50 }];

    const names = [
      { name: 'EVENT_YEARS', ref: `Life_Events!$A$${startR + 1}:$A$${startR + EVENTS_MAX_ROWS}` },
      { name: 'EVENT_AMTS',  ref: `Life_Events!$B$${startR + 1}:$B$${startR + EVENTS_MAX_ROWS}` },
    ];
    return { sheet: ws, names };
  }

  /* ────────────────────────────────────────────────────────────────────────
     TAX_TABLES SHEET — read-only reference for the SLAB_TAX_BASE LAMBDA.
     If statutory slabs change, the user only needs to edit the values here.
     ──────────────────────────────────────────────────────────────────────── */
  function buildTaxTablesSheet(XLSX) {
    const rows = [];
    rows.push([s('Tax Tables — FY 2025-26 New Regime'), s(''), s('')]);
    rows.push([s("If statutory slabs change, edit values here and every strategy sheet recalculates.")]);
    rows.push([]);
    rows.push([s('Lower (₹)'), s('Upper (₹)'), s('Rate')]);
    const startR = rows.length;
    SLAB_TABLE.forEach(([lo, hi, rate]) => {
      rows.push([n(lo, NUM_FMT.inr), n(hi, NUM_FMT.inr), n(rate, NUM_FMT.pctd)]);
    });
    const endR = rows.length;

    rows.push([]);
    rows.push([s('Constants'), s(''), s('')]);
    rows.push([s('§87A rebate income ceiling'),       n(1200000, NUM_FMT.inr),  s('Income ≤ this → tax = 0 (with marginal relief)')]);
    rows.push([s('§80TTB senior interest deduction'), n(50000,   NUM_FMT.inr),  s('Applied to senior\'s total income before slab')]);
    rows.push([s('Surcharge threshold #1 (10%)'),     n(5000000, NUM_FMT.inr),  s('Rate = 10% with marginal relief')]);
    rows.push([s('Surcharge threshold #2 (15%)'),     n(10000000, NUM_FMT.inr), s('Rate = 15% with marginal relief')]);
    rows.push([s('Surcharge threshold #3 (25%)'),     n(20000000, NUM_FMT.inr), s('Rate = 25% with marginal relief (New Regime cap)')]);
    rows.push([s('Health & Education cess'),          n(0.04,    NUM_FMT.pctd), s('4% on (tax + surcharge)')]);

    const ws = aoaToSheet(XLSX, rows);
    ws['!cols'] = [{ wch: 36 }, { wch: 16 }, { wch: 60 }];

    const names = [
      { name: 'TAX_LOWER', ref: `Tax_Tables!$A$${startR + 1}:$A$${endR}` },
      { name: 'TAX_UPPER', ref: `Tax_Tables!$B$${startR + 1}:$B$${endR}` },
      { name: 'TAX_RATE',  ref: `Tax_Tables!$C$${startR + 1}:$C$${endR}` },
    ];
    return { sheet: ws, names };
  }

  /* ────────────────────────────────────────────────────────────────────────
     LAMBDAs — the workbook's tax & lookup engine.  Each is registered as a
     workbook-level defined name.  Both Excel 365 (web + desktop subscription)
     and Google Sheets evaluate LAMBDA natively.
     ──────────────────────────────────────────────────────────────────────── */
  function buildLambdas() {
    /* SLAB_TAX_BASE(x) — raw slab tax, before 80TTB / 87A / surcharge / cess.
       Uses the SUMPRODUCT identity:
         contribution_per_slab = max(x-lo, 0) - max(x-hi, 0)
       which evaluates to min(x-lo, hi-lo) when x>lo and 0 otherwise. */
    const SLAB_TAX_BASE =
      'LAMBDA(x,' +
        'SUMPRODUCT(' +
          '((x-TAX_LOWER)*(x>TAX_LOWER)-(x-TAX_UPPER)*(x>TAX_UPPER))*TAX_RATE' +
        ')' +
      ')';

    /* PRE_SURCHARGE(income) — apply 80TTB (seniors), then 87A rebate with
       marginal relief, then slab tax. */
    const PRE_SURCHARGE =
      'LAMBDA(income,' +
        'LET(' +
          'inc, MAX(0, income - IS_SENIOR*50000),' +
          'base, SLAB_TAX_BASE(inc),' +
          'IF(inc<=1200000, 0, MIN(base, inc - 1200000))' +
        ')' +
      ')';

    /* WITH_SURCHARGE(income) — add surcharge with marginal relief at each
       threshold (10% / 15% / 25%), then 4% cess. Mirrors computeSlabTax() in
       the JS engine.  `inc` (post-80TTB) is the *total income* used for the
       threshold tests.  The marginal-relief ceilings use SLAB_TAX_BASE at the
       threshold itself — i.e. the tax on a total income equal to the threshold,
       with NO further 80TTB subtraction (the threshold is already a total-income
       figure).  Using PRE_SURCHARGE here would deduct 80TTB a second time and
       under-state the ceiling for seniors (≈ ₹15,600/filer above ₹50 L).  Since
       every threshold is far above the ₹12 L 87A ceiling, SLAB_TAX_BASE equals
       the JS preSurchargeTax() at those points. */
    const WITH_SURCHARGE =
      'LAMBDA(income,' +
        'LET(' +
          'inc, MAX(0, income - IS_SENIOR*50000),' +
          't, PRE_SURCHARGE(income),' +
          'c5L,  SLAB_TAX_BASE(5000000) + MAX(0, inc - 5000000),' +
          'c1Cr, SLAB_TAX_BASE(10000000) * 1.10 + MAX(0, inc - 10000000),' +
          'c2Cr, SLAB_TAX_BASE(20000000) * 1.15 + MAX(0, inc - 20000000),' +
          'sc,' +
            'IF(inc>20000000,' +
              'IF(t + t*0.25 > c2Cr, MAX(0, c2Cr - t), t*0.25),' +
            'IF(inc>10000000,' +
              'IF(t + t*0.15 > c1Cr, MAX(0, c1Cr - t), t*0.15),' +
            'IF(inc>5000000,' +
              'IF(t + t*0.10 > c5L, MAX(0, c5L - t), t*0.10),' +
              '0))),' +
          '(t + sc) * 1.04' +
        ')' +
      ')';

    /* FD_TAX(grossInt) — final effective tax on FD interest given current
       mode (flat vs slab) and spouse split.  Mirrors fdTaxOn() in app.js. */
    const FD_TAX =
      'LAMBDA(grossInt,' +
        'IF(TAX_MODE_FLAT=1,' +
          'grossInt * FLAT_RATE / 100,' +
          'IF(SPOUSE=1,' +
            '2 * MAX(0, WITH_SURCHARGE((grossInt + OTHER_INC)/2) - WITH_SURCHARGE(OTHER_INC/2)),' +
            'MAX(0, WITH_SURCHARGE(grossInt + OTHER_INC) - WITH_SURCHARGE(OTHER_INC))' +
          ')' +
        ')' +
      ')';

    /* LIFESTYLE multiplier by age. */
    const LIFE_MULT =
      'LAMBDA(age,' +
        'IF(age>=75, LIFE_OLD, IF(age>=65, LIFE_MID, 1))' +
      ')';

    /* ANNUITY_RATE by age — discrete step function, RoP variant. */
    const ANN_RATE =
      'LAMBDA(age,' +
        'IF(age>=75, 0.08,' +
        'IF(age>=70, 0.072,' +
        'IF(age>=65, 0.065,' +
        'IF(age>=60, 0.062, 0.058))))' +
      ')';

    /* LTCG_FREE — per-year shared exemption (doubles if spouse). */
    const LTCG_FREE =
      'LAMBDA(IF(SPOUSE=1, 2, 1) * LTCG_EXEMPT)';

    /* EVENT_IN(yr) — total life-event outflow scheduled for that year. */
    const EVENT_IN =
      'LAMBDA(yr, SUMIFS(EVENT_AMTS, EVENT_YEARS, yr))';

    /* `vars` lists each LAMBDA's local parameters / LET variables so they can be
       tagged with the `_xlpm.` prefix Excel requires (see xlfnify). Names that
       refer to OTHER defined names (CORPUS, WITH_SURCHARGE, SLAB_TAX_BASE, …) are
       NOT locals and must stay unprefixed. */
    return [
      { name: 'SLAB_TAX_BASE', ref: SLAB_TAX_BASE, vars: ['x'] },
      { name: 'PRE_SURCHARGE', ref: PRE_SURCHARGE, vars: ['income', 'inc', 'base'] },
      { name: 'WITH_SURCHARGE', ref: WITH_SURCHARGE, vars: ['income', 'inc', 't', 'c5L', 'c1Cr', 'c2Cr', 'sc'] },
      { name: 'FD_TAX',        ref: FD_TAX,    vars: ['grossInt'] },
      { name: 'LIFE_MULT',     ref: LIFE_MULT, vars: ['age'] },
      { name: 'ANN_RATE',      ref: ANN_RATE,  vars: ['age'] },
      { name: 'LTCG_FREE',     ref: LTCG_FREE, vars: [] },
      { name: 'EVENT_IN',      ref: EVENT_IN,  vars: ['yr'] },
    ];
  }

  /* ────────────────────────────────────────────────────────────────────────
     EXCEL-COMPATIBILITY SHIM for modern functions inside defined names.
     SheetJS writes formula text verbatim — it does NOT add the `_xlfn.` /
     `_xlpm.` prefixes Excel 365 stores for LAMBDA, LET, and their bound
     variables.  Without these prefixes every LAMBDA/LET resolves to #NAME? in
     Excel desktop (Google Sheets is more lenient but also accepts the prefixed
     form on import).  xlfnify() rewrites:
        LAMBDA( → _xlfn.LAMBDA(      LET( → _xlfn.LET(
        each declared local var  →   _xlpm.<var>   (whole-word, every use)
     Calls to other defined-name LAMBDAs and references to named ranges are left
     untouched because they are workbook names, not built-ins or locals.
     ──────────────────────────────────────────────────────────────────────── */
  function xlfnify(formula, vars) {
    let out = formula
      .replace(/\bLAMBDA\(/g, '_xlfn.LAMBDA(')
      .replace(/\bLET\(/g, '_xlfn.LET(');
    /* Longest names first so a short var can't pre-empt a longer one. */
    const sorted = [...(vars || [])].sort((a, b) => b.length - a.length);
    for (const v of sorted) {
      const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Match `v` only as a standalone identifier: not preceded by an identifier
      // char or a dot (so an already-prefixed token is skipped), not followed by
      // an identifier char.
      const re = new RegExp('(^|[^A-Za-z0-9_.])' + esc + '(?![A-Za-z0-9_])', 'g');
      out = out.replace(re, '$1_xlpm.' + v);
    }
    return out;
  }

  /* ────────────────────────────────────────────────────────────────────────
     Per-year row helper.  Returns the cell-reference strings for *this* row.
     We use these to build formulas that reference previous-row state
     (eg. eqEnd, eqCostEnd) without hardcoding spreadsheet coordinates.
     ──────────────────────────────────────────────────────────────────────── */
  function rowRefs(rowIdx, headers) {
    /* headers is an array of column-header strings, in order.
       Returns a map header → A1-style reference, e.g. { 'fdEnd': 'M5' } */
    const map = {};
    headers.forEach((h, i) => { map[h] = cellRef(i, rowIdx); });
    return map;
  }
  function prevRef(c, refsMap) {
    /* For a column letter from the *current* row's map, return the
       same column on the row above (rowIdx − 1). */
    const ref = refsMap[c];
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    return m[1] + (parseInt(m[2], 10) - 1);
  }

  /* Common helper: build the per-year header row used by all strategies. */
  function commonExpenseFormulas(rowR, isStrat) {
    /* rowR : map of column-header → A1 ref for THIS row
       isStrat: optional strategy tag (currently unused; kept for future tweaks)

       Produces a partial formula map for the per-year inflation-driven
       outflow columns that are shared across every strategy. */
    return {
      age:           f(`START_AGE + ${rowR.yr} - 1`, NUM_FMT.int),
      lifeMult:      f(`LIFE_MULT(${rowR.age})`, NUM_FMT.mult),
      monthlyExp:    f(`MONTHLY_EXP * (1+INFL/100)^(${rowR.yr}-1) * ${rowR.lifeMult}`, NUM_FMT.inr),
      annualExp:     f(`${rowR.monthlyExp} * 12`, NUM_FMT.inr),
      health:        f(`HEALTH_INS * (1+HEALTH_INFL/100)^(${rowR.yr}-1)`, NUM_FMT.inr),
      pension:       f(`PENSION * IF(PENSION_INFL_F=1, (1+INFL/100)^(${rowR.yr}-1), 1)`, NUM_FMT.inr),
      eventOut:      f(`EVENT_IN(${rowR.yr})`, NUM_FMT.inr),
      totalOutflow:  f(`${rowR.annualExp} + ${rowR.health} + ${rowR.eventOut}`, NUM_FMT.inr),
      inflFactor:    f(`(1+INFL/100)^${rowR.yr}`, NUM_FMT.mult),
    };
  }

  /* Single canonical column ordering for all strategy sheets — keeps the
     workbook visually consistent and lets the Summary sheet pull from the
     same columns by name on any projection. */
  const COMMON_HEADERS = [
    'yr', 'age', 'lifeMult',
    'monthlyExp', 'annualExp', 'health', 'pension', 'eventOut', 'totalOutflow',
    'fdStart', 'eqStart', 'eqCostStart',
    /* SWP-specific state columns — zero for non-SWP strategies. */
    'liquidStart', 'arbStart', 'arbCostStart',
    'gross', 'tax', 'net',
    'eqGrown',
    /* SWP intermediate growth columns. */
    'liquidGrown', 'arbGrown',
    'incomeIn', 'shortfall', 'surplus',
    'fdDraw', 'fdAfterDraw',
    'ltcgFreeInit',
    'eqSell1', 'eqGain1', 'eqTax1', 'eqNetCash1', 'eqRem1', 'eqCostRem1', 'usedFromCash1', 'cashToFd1', 'ltcgLeft1',
    /* SWP arb-sale-for-expense columns. */
    'arbSell1', 'arbGain1', 'arbTax1', 'arbNetCash1', 'arbRem1', 'arbCostRem1',
    'fdMid', 'eqMid', 'eqCostMid',
    /* SWP mid-year arb/liquid state. */
    'arbMid', 'arbCostMid', 'liquidMid',
    'rebalFlag',
    'eqSell2', 'eqGain2', 'eqTax2', 'eqNetCash2',
    'fdEnd', 'eqEnd', 'harvested', 'eqCostEnd',
    /* SWP cost-basis tracking & harvesting. */
    'arbCostEnd', 'harvestedArb',
    'eqTaxYr',
    'totalEnd', 'inflFactor', 'realEnd', 'wdRate',
  ];
  const HEADER_LABELS = {
    yr: 'Year', age: 'Age', lifeMult: 'Age spend ×',
    monthlyExp: 'Spending/month', annualExp: 'Spending/year', health: 'Health insurance', pension: 'Pension/rent',
    eventOut: 'One-off cost', totalOutflow: 'Spent this year',
    fdStart: 'Safe at start', eqStart: 'Stocks at start', eqCostStart: 'Stocks cost at start',
    liquidStart: 'Cash at start', arbStart: 'Low-tax fund at start', arbCostStart: 'Fund cost at start',
    gross: 'Interest (before tax)', tax: 'Tax on interest', net: 'Interest (after tax)',
    eqGrown: 'Stocks after growth',
    liquidGrown: 'Cash after growth', arbGrown: 'Fund after growth',
    incomeIn: 'Income coming in', shortfall: 'Short by', surplus: 'Spare',
    fdDraw: 'Taken from safe savings', fdAfterDraw: 'Safe after taking out',
    ltcgFreeInit: 'Tax-free profit left',
    eqSell1: 'Stocks sold (for spending)', eqGain1: 'Profit (for spending)', eqTax1: 'Tax (for spending)',
    eqNetCash1: 'Cash from stocks (spending)', eqRem1: 'Stocks left (spending)', eqCostRem1: 'Stocks cost left (spending)',
    usedFromCash1: 'Used from stock cash', cashToFd1: 'Cash moved to safe', ltcgLeft1: 'Tax-free profit still left',
    arbSell1: 'Fund sold (for spending)', arbGain1: 'Fund profit (spending)', arbTax1: 'Fund tax (spending)',
    arbNetCash1: 'Cash from fund (spending)', arbRem1: 'Fund left (spending)', arbCostRem1: 'Fund cost left (spending)',
    fdMid: 'Safe mid-year', eqMid: 'Stocks mid-year', eqCostMid: 'Stocks cost mid-year',
    arbMid: 'Fund mid-year', arbCostMid: 'Fund cost mid-year', liquidMid: 'Cash mid-year',
    rebalFlag: 'Moved to safe?',
    eqSell2: 'Stocks sold (move to safe)', eqGain2: 'Profit (move to safe)', eqTax2: 'Tax (move to safe)', eqNetCash2: 'Cash (move to safe)',
    fdEnd: 'Safe at end', eqEnd: 'Stocks at end', harvested: 'Tax-free profit booked', eqCostEnd: 'Stocks cost at end',
    arbCostEnd: 'Fund cost at end', harvestedArb: 'Fund tax-free profit booked',
    eqTaxYr: 'Stock tax this year',
    totalEnd: 'Total at end', inflFactor: 'Price-rise factor', realEnd: 'Total (today\'s value)', wdRate: '% taken out',
  };

  /* ────────────────────────────────────────────────────────────────────────
     PROJECTION SHEET BUILDERS — five strategies share the same column layout
     but differ in how fdStart/eqStart/eqCostStart evolve and whether they
     execute the rebalance / SCSS / SWP / annuity branch.

     The buildProjection() helper takes a "strategy descriptor" that exposes
     the per-row strategy-specific formulas; the loop wires the column
     calls together.
     ──────────────────────────────────────────────────────────────────────── */
  function buildProjection(XLSX, sheetName, inp, strategy) {
    const N = inp.maxYears;
    const HEADERS = COMMON_HEADERS;
    const rows = [];

    /* Title rows */
    rows.push([s(strategy.title)]);
    rows.push([s(strategy.subtitle)]);
    rows.push([s('Worked out for you — every cell below is a formula based on your numbers, so it updates if you change them.')]);
    rows.push([]);
    /* Header row */
    rows.push(HEADERS.map(h => s(HEADER_LABELS[h])));
    const headerRowIdx = rows.length - 1;

    for (let yr = 1; yr <= N; yr++) {
      const rIdx = rows.length;                    // 0-based index of this row in `rows`
      const rowR = rowRefs(rIdx, HEADERS);         // {colName -> A1 ref of THIS row}
      const prev = (cName) => col(HEADERS.indexOf(cName)) + rIdx;  // SAME col, previous row

      /* Strategy descriptor provides the four cornerstone formulas: */
      const sf = strategy.formulas(yr, rowR, prev);

      /* Common expenses block — same for all strategies. */
      const ex = commonExpenseFormulas(rowR);

      /* Assemble the row by header name, in COMMON_HEADERS order. */
      const cells = HEADERS.map((h) => {
        switch (h) {
          case 'yr':             return n(yr, NUM_FMT.int);
          case 'age':            return ex.age;
          case 'lifeMult':       return ex.lifeMult;
          case 'monthlyExp':     return ex.monthlyExp;
          case 'annualExp':      return ex.annualExp;
          case 'health':         return ex.health;
          case 'pension':        return ex.pension;
          case 'eventOut':       return ex.eventOut;
          case 'totalOutflow':   return ex.totalOutflow;

          case 'fdStart':        return sf.fdStart;
          case 'eqStart':        return sf.eqStart;
          case 'eqCostStart':    return sf.eqCostStart;

          case 'gross':          return sf.gross;
          case 'tax':            return f(`FD_TAX(${rowR.gross})`, NUM_FMT.inr);
          case 'net':            return f(`${rowR.gross} - ${rowR.tax}`, NUM_FMT.inr);

          case 'eqGrown':        return f(`${rowR.eqStart} * (1 + EQ_RATE/100)`, NUM_FMT.inr);

          case 'incomeIn':       return f(`${rowR.net} + ${rowR.pension}`, NUM_FMT.inr);
          case 'shortfall':      return f(`MAX(0, ${rowR.totalOutflow} - ${rowR.incomeIn})`, NUM_FMT.inr);
          case 'surplus':        return f(`MAX(0, ${rowR.incomeIn} - ${rowR.totalOutflow})`, NUM_FMT.inr);

          /* fdDraw caps at the *drawable* portion of FD — for strategies with a
             locked sub-bucket (e.g. SCSS), the locked principal cannot be drawn.
             Default locked = 0 (entire fdStart is drawable). */
          case 'fdDraw': {
            const locked = strategy.lockedBucket || '0';
            return f(`MIN(${rowR.shortfall}, MAX(0, ${rowR.fdStart} - (${locked})))`, NUM_FMT.inr);
          }
          case 'fdAfterDraw':    return f(`${rowR.fdStart} + ${rowR.surplus} - ${rowR.fdDraw}`, NUM_FMT.inr);

          case 'ltcgFreeInit':   return f(`IF(SPOUSE=1, 2, 1) * LTCG_EXEMPT`, NUM_FMT.inr);

          /* First equity sale — to cover the residual outflow shortfall, with
             a 15% gross-up (50/50) or 5% (SCSS).  Strategies that don't sell
             equity to cover expenses (Pure FD / Annuity) just zero this out. */
          case 'eqSell1': {
            const still = `MAX(0, ${rowR.shortfall} - ${rowR.fdDraw})`;
            const grossUp = sf.expenseGrossUp || 1.15;
            const need = `${still} * ${grossUp}`;
            return f(`IF(AND(${rowR.eqGrown}>0, ${still}>0), MIN(${need}, ${rowR.eqGrown}), 0)`, NUM_FMT.inr);
          }
          case 'eqGain1':        return f(`${rowR.eqSell1} - ${rowR.eqCostStart} * IF(${rowR.eqGrown}>0, ${rowR.eqSell1}/${rowR.eqGrown}, 0)`, NUM_FMT.inr);
          case 'eqTax1':         return f(`MAX(0, ${rowR.eqGain1} - ${rowR.ltcgFreeInit}) * LTCG_RATE / 100`, NUM_FMT.inr);
          case 'eqNetCash1':     return f(`${rowR.eqSell1} - ${rowR.eqTax1}`, NUM_FMT.inr);
          case 'eqRem1':         return f(`${rowR.eqGrown} - ${rowR.eqSell1}`, NUM_FMT.inr);
          case 'eqCostRem1':     return f(`${rowR.eqCostStart} - ${rowR.eqCostStart} * IF(${rowR.eqGrown}>0, ${rowR.eqSell1}/${rowR.eqGrown}, 0)`, NUM_FMT.inr);
          case 'usedFromCash1':  return f(`MIN(${rowR.eqNetCash1}, MAX(0, ${rowR.shortfall} - ${rowR.fdDraw}))`, NUM_FMT.inr);
          case 'cashToFd1':      return f(`${rowR.eqNetCash1} - ${rowR.usedFromCash1}`, NUM_FMT.inr);
          case 'ltcgLeft1':      return f(`MAX(0, ${rowR.ltcgFreeInit} - ${rowR.eqGain1})`, NUM_FMT.inr);

          /* fdMid / eqMid / eqCostMid — state after expense draws but before
             any rebalance / SCSS top-up.  Strategies override fdMid/eqMid
             logic via sf.midState if needed. */
          case 'fdMid':          return sf.fdMid ? sf.fdMid(rowR) : f(`${rowR.fdAfterDraw} + ${rowR.cashToFd1}`, NUM_FMT.inr);
          case 'eqMid':          return sf.eqMid ? sf.eqMid(rowR) : f(`${rowR.eqRem1}`, NUM_FMT.inr);
          case 'eqCostMid':      return sf.eqCostMid ? sf.eqCostMid(rowR) : f(`${rowR.eqCostRem1}`, NUM_FMT.inr);

          /* Strategy-specific rebalance branch.  For Pure FD / Annuity / SWP
             we set rebalFlag=FALSE and eqSell2 / eqTax2 / eqNetCash2 = 0. */
          case 'rebalFlag':      return sf.rebalFlag ? sf.rebalFlag(rowR) : fb(`FALSE`);
          case 'eqSell2':        return sf.eqSell2 ? sf.eqSell2(rowR) : f(`0`, NUM_FMT.inr);
          case 'eqGain2':        return sf.eqGain2 ? sf.eqGain2(rowR) : f(`0`, NUM_FMT.inr);
          case 'eqTax2':         return sf.eqTax2 ? sf.eqTax2(rowR) : f(`0`, NUM_FMT.inr);
          case 'eqNetCash2':     return sf.eqNetCash2 ? sf.eqNetCash2(rowR) : f(`0`, NUM_FMT.inr);

          case 'fdEnd':          return sf.fdEnd(rowR);
          case 'eqEnd':          return sf.eqEnd(rowR);
          /* harvested — tax-gain harvesting on the equity bucket: sell-and-rebuy
             equity to crystallise gains up to the remaining LTCG exemption. Cost
             basis steps up tax-free.  Returns 0 for strategies with no equity. */
          case 'harvested': {
            const preCost = sf.preCostEnd
              ? sf.preCostEnd(rowR)
              : `(${rowR.eqCostMid} - ${rowR.eqCostMid} * IF(${rowR.eqMid}>0, ${rowR.eqSell2}/${rowR.eqMid}, 0))`;
            const exempLeft = sf.harvestExempLeft
              ? sf.harvestExempLeft(rowR)
              : `MAX(0, ${rowR.ltcgFreeInit} - ${rowR.eqGain1} - ${rowR.eqGain2})`;
            const unrealised = `${rowR.eqEnd} - ${preCost}`;
            return f(`IF(TAX_HARVEST=1, MAX(0, MIN(${exempLeft}, MAX(0, ${unrealised}))), 0)`, NUM_FMT.inr);
          }
          case 'eqCostEnd':      return sf.eqCostEnd(rowR);

          /* SWP-specific state columns — default to 0/empty for non-SWP strategies. */
          case 'liquidStart':    return sf.liquidStart ? sf.liquidStart(rowR) : f(`0`, NUM_FMT.inr);
          case 'arbStart':       return sf.arbStart    ? sf.arbStart(rowR)    : f(`0`, NUM_FMT.inr);
          case 'arbCostStart':   return sf.arbCostStart? sf.arbCostStart(rowR): f(`0`, NUM_FMT.inr);
          case 'liquidGrown':    return sf.liquidGrown ? sf.liquidGrown(rowR) : f(`0`, NUM_FMT.inr);
          case 'arbGrown':       return sf.arbGrown    ? sf.arbGrown(rowR)    : f(`0`, NUM_FMT.inr);
          case 'arbSell1':       return sf.arbSell1    ? sf.arbSell1(rowR)    : f(`0`, NUM_FMT.inr);
          case 'arbGain1':       return sf.arbGain1    ? sf.arbGain1(rowR)    : f(`0`, NUM_FMT.inr);
          case 'arbTax1':        return sf.arbTax1     ? sf.arbTax1(rowR)     : f(`0`, NUM_FMT.inr);
          case 'arbNetCash1':    return sf.arbNetCash1 ? sf.arbNetCash1(rowR) : f(`0`, NUM_FMT.inr);
          case 'arbRem1':        return sf.arbRem1     ? sf.arbRem1(rowR)     : f(`0`, NUM_FMT.inr);
          case 'arbCostRem1':    return sf.arbCostRem1 ? sf.arbCostRem1(rowR) : f(`0`, NUM_FMT.inr);
          case 'arbMid':         return sf.arbMid      ? sf.arbMid(rowR)      : f(`0`, NUM_FMT.inr);
          case 'arbCostMid':     return sf.arbCostMid  ? sf.arbCostMid(rowR)  : f(`0`, NUM_FMT.inr);
          case 'liquidMid':      return sf.liquidMid   ? sf.liquidMid(rowR)   : f(`0`, NUM_FMT.inr);
          case 'arbCostEnd':     return sf.arbCostEnd  ? sf.arbCostEnd(rowR)  : f(`0`, NUM_FMT.inr);
          case 'harvestedArb':   return sf.harvestedArb? sf.harvestedArb(rowR): f(`0`, NUM_FMT.inr);

          /* eqTaxYr — sum of all LTCG taxes for the year, including arb tax in SWP. */
          case 'eqTaxYr':        return f(`${rowR.eqTax1} + ${rowR.eqTax2} + ${rowR.arbTax1}`, NUM_FMT.inr);

          case 'totalEnd':       return f(`MAX(0, ${rowR.fdEnd} + ${rowR.eqEnd})`, NUM_FMT.inr);
          case 'inflFactor':     return ex.inflFactor;
          case 'realEnd':        return f(`${rowR.totalEnd} / ${rowR.inflFactor}`, NUM_FMT.inr);
          case 'wdRate':         return f(`${rowR.totalOutflow} / MAX(1, ${rowR.fdStart} + ${rowR.eqStart})`, NUM_FMT.rate2);
          default:               return s('');
        }
      });
      rows.push(cells);
    }

    /* Append a Footer row with totals & summary stats — formula-driven. */
    const lastDataRowExcel = headerRowIdx + 1 + N;   // 1-based
    const firstDataRowExcel = headerRowIdx + 2;

    const colE = (h) => col(HEADERS.indexOf(h)) +     `${firstDataRowExcel}:` +
                       col(HEADERS.indexOf(h)) + `${lastDataRowExcel}`;

    rows.push([]);
    rows.push([s('Summary'), s(''), s(''), s(''), s(''), s(''), s(''), s(''), s('')]);
    rows.push([s('Years it lasts'),  f(`COUNTIF(${colE('totalEnd')}, ">0")`, NUM_FMT.int)]);
    rows.push([s('Money left at end (actual ₹)'), f(`INDEX(${colE('totalEnd')}, MAX_YEARS)`, NUM_FMT.inr)]);
    rows.push([s("Money left at end (today's value)"), f(`INDEX(${colE('realEnd')}, MAX_YEARS)`, NUM_FMT.inr)]);
    rows.push([s('Total tax on interest'), f(`SUM(${colE('tax')})`, NUM_FMT.inr)]);
    rows.push([s('Total tax on stock profit'), f(`SUM(${colE('eqTaxYr')})`, NUM_FMT.inr)]);
    /* Harvested profit = equity column + arbitrage column (SWP harvests both;
       all other strategies leave harvestedArb = 0). Mirrors the JS engine's
       totalHarvested = he.harvested + ha.harvested. */
    rows.push([s('Total profit booked tax-free'), f(`SUM(${colE('harvested')}) + SUM(${colE('harvestedArb')})`, NUM_FMT.inr)]);
    rows.push([s('Tax saved by the yearly tax-saver'), f(`(SUM(${colE('harvested')}) + SUM(${colE('harvestedArb')})) * LTCG_RATE / 100`, NUM_FMT.inr)]);
    rows.push([s('Total spending'), f(`SUM(${colE('totalOutflow')})`, NUM_FMT.inr)]);
    rows.push([s('Total one-off costs'), f(`SUM(${colE('eventOut')})`, NUM_FMT.inr)]);
    rows.push([s('Times moved to safe'), f(`COUNTIF(${col(HEADERS.indexOf('rebalFlag'))}${firstDataRowExcel}:${col(HEADERS.indexOf('rebalFlag'))}${lastDataRowExcel}, TRUE)`, NUM_FMT.int)]);
    rows.push([s('Money-to-leave goal (today\'s value)'), f(`BEQUEST`, NUM_FMT.inr)]);
    rows.push([s('Goal met?'), fb(`INDEX(${colE('realEnd')}, MAX_YEARS) >= BEQUEST`)]);

    const ws = aoaToSheet(XLSX, rows);
    /* Column widths */
    const widths = HEADERS.map((h) => {
      const lab = HEADER_LABELS[h] || h;
      return { wch: Math.max(10, Math.min(22, lab.length + 4)) };
    });
    ws['!cols'] = widths;
    ws['!freeze'] = { xSplit: 2, ySplit: headerRowIdx + 1, topLeftCell: 'C' + (headerRowIdx + 2), activePane: 'bottomRight' };
    return ws;
  }

  /* Strategy descriptors. */
  function strat_5050(inp) {
    const initFd = `CORPUS * FD_PCT / 100`;
    const initEq = `CORPUS - (CORPUS * FD_PCT / 100)`;
    return {
      title: 'Plan — Half safe, half stocks',
      subtitle: 'Live off the interest first; when the safe side runs low, sell some stocks to top it up.',
      formulas: (yr, rowR, prev) => ({
        fdStart:     yr === 1 ? f(`${initFd}`, NUM_FMT.inr)
                              : f(`${prev('fdEnd')}`, NUM_FMT.inr),
        eqStart:     yr === 1 ? f(`${initEq}`, NUM_FMT.inr)
                              : f(`${prev('eqEnd')}`, NUM_FMT.inr),
        eqCostStart: yr === 1 ? f(`${initEq}`, NUM_FMT.inr)
                              : f(`${prev('eqCostEnd')}`, NUM_FMT.inr),
        gross:       f(`${rowR.fdStart} * FD_RATE / 100`, NUM_FMT.inr),
        expenseGrossUp: 1.15,
        rebalFlag:   (R) => fb(`AND(${R.fdStart}>5000, ${R.fdMid}<5000, ${R.eqMid}>0)`),
        eqSell2:     (R) => f(`IF(${R.rebalFlag}, ${R.eqMid}/2, 0)`, NUM_FMT.inr),
        eqGain2:     (R) => f(`${R.eqSell2} - ${R.eqCostMid} * IF(${R.eqMid}>0, ${R.eqSell2}/${R.eqMid}, 0)`, NUM_FMT.inr),
        eqTax2:      (R) => f(`MAX(0, ${R.eqGain2} - ${R.ltcgLeft1}) * LTCG_RATE / 100`, NUM_FMT.inr),
        eqNetCash2:  (R) => f(`${R.eqSell2} - ${R.eqTax2}`, NUM_FMT.inr),
        /* On a rebalance the JS engine REPLACES fd with the net cash from the
           equity sale (the small fdMid residual is absorbed).  Without a
           rebalance, we just add the equity net cash (which is 0). */
        fdEnd:       (R) => f(`IF(${R.rebalFlag}, ${R.eqNetCash2}, ${R.fdMid} + ${R.eqNetCash2})`, NUM_FMT.inr),
        eqEnd:       (R) => f(`${R.eqMid} - ${R.eqSell2}`, NUM_FMT.inr),
        eqCostEnd:   (R) => f(`${R.eqCostMid} - ${R.eqCostMid} * IF(${R.eqMid}>0, ${R.eqSell2}/${R.eqMid}, 0) + ${R.harvested}`, NUM_FMT.inr),
      }),
    };
  }

  function strat_pureFD(inp) {
    return {
      title: 'Plan — All in bank deposits',
      subtitle: 'Everything stays in fixed deposits. Rising prices slowly eat away what your money can buy.',
      formulas: (yr, rowR, prev) => ({
        fdStart:     yr === 1 ? f(`CORPUS`, NUM_FMT.inr) : f(`${prev('fdEnd')}`, NUM_FMT.inr),
        eqStart:     f(`0`, NUM_FMT.inr),
        eqCostStart: f(`0`, NUM_FMT.inr),
        gross:       f(`${rowR.fdStart} * FD_RATE / 100`, NUM_FMT.inr),
        expenseGrossUp: 1.15,                            // no equity sales anyway
        fdMid:       (R) => f(`MAX(0, ${R.fdStart} + ${R.incomeIn} - ${R.totalOutflow})`, NUM_FMT.inr),
        eqMid:       (R) => f(`0`, NUM_FMT.inr),
        eqCostMid:   (R) => f(`0`, NUM_FMT.inr),
        fdEnd:       (R) => f(`${R.fdMid}`, NUM_FMT.inr),
        eqEnd:       (R) => f(`0`, NUM_FMT.inr),
        eqCostEnd:   (R) => f(`0`, NUM_FMT.inr),
      }),
    };
  }

  function strat_scss(inp) {
    /* SCSS-led: ₹30 L (₹60 L if spouse) parked at 8.2%, balance in FD, rest in
       equity.  The KEY structural property is that the SCSS principal is
       LOCKED — once you put it in, you can't touch the principal until the
       term ends (5+3 years by default).  The JS engine models this by keeping
       a separate `scss` bucket that never changes.

       In Excel we mirror this by:
         (1) storing fdStart = scssBucket + fdSlice  for display, but
         (2) exposing lockedBucket = scssBucket so the common fdDraw formula
             caps draws at fdStart - scssBucket (= fdSlice), and
         (3) computing gross interest as scssBucket * 8.2% + fdSlice * FD_RATE,
             where fdSlice = fdStart - scssBucket (re-derived each year from
             the constant lockedBucket value).
         (4) computing the top-up target against fdSlice (not the combined
             value) so the rebalance fires at the right moment. */
    const scssCap     = `IF(SPOUSE=1, 6000000, 3000000)`;
    const fixedTotal  = `CORPUS * FD_PCT / 100`;
    const lockedBucket = `MIN(${scssCap}, ${fixedTotal})`;     // CONSTANT
    const initFd      = `${fixedTotal} - ${lockedBucket}`;
    const initEq      = `CORPUS - ${fixedTotal}`;
    return {
      title: "Plan — Senior citizens' scheme",
      subtitle: 'Senior scheme at 8.2% (₹30L alone / ₹60L as a couple) + safe savings + stocks; top up the safe side each year.',
      lockedBucket,                                            // exposed to common formulas
      formulas: (yr, rowR, prev) => ({
        fdStart:     yr === 1 ? f(`${initFd} + ${lockedBucket}`, NUM_FMT.inr) : f(`${prev('fdEnd')}`, NUM_FMT.inr),
        eqStart:     yr === 1 ? f(`${initEq}`, NUM_FMT.inr) : f(`${prev('eqEnd')}`, NUM_FMT.inr),
        eqCostStart: yr === 1 ? f(`${initEq}`, NUM_FMT.inr) : f(`${prev('eqCostEnd')}`, NUM_FMT.inr),
        /* gross = scssBucket * 8.2%  +  (fdStart - scssBucket) * FD_RATE/100. */
        gross:       f(`${lockedBucket} * ${SCSS_RATE} + MAX(0, ${rowR.fdStart} - ${lockedBucket}) * FD_RATE / 100`, NUM_FMT.inr),
        expenseGrossUp: 1.05,
        /* Annual top-up — aim for 5 × outflow in the FD SLICE (not combined),
           sell equity to plug the gap; cap the realised gain at the remaining
           LTCG exemption in early years (yr ≤ 8).  Sale is capped by available
           equity (eqMid) — mirrors the eq cap inside withdrawEquity(). */
        rebalFlag:   (R) => fb(`${R.eqSell2} >= 50000`),
        eqSell2:     (R) => {
          const fdSliceMid = `MAX(0, ${R.fdMid} - ${lockedBucket})`;
          const desired    = `${R.totalOutflow} * 5`;
          const target     = `MAX(0, ${desired} - ${fdSliceMid})`;
          const vOverC     = `IF(${R.eqMid}>0, MAX(0, 1 - ${R.eqCostMid}/${R.eqMid}), 0)`;
          const tipEx      = `${R.ltcgLeft1} / MAX(0.0001, ${vOverC})`;
          const smart      = `IF(AND(${vOverC}>0.01, ${rowR.yr}<=8), MIN(${target}, ${tipEx}), ${target})`;
          return f(`IF(${R.eqMid}>0, MIN(${R.eqMid}, MAX(0, ${smart})), 0)`, NUM_FMT.inr);
        },
        eqGain2:     (R) => f(`${R.eqSell2} - ${R.eqCostMid} * IF(${R.eqMid}>0, ${R.eqSell2}/${R.eqMid}, 0)`, NUM_FMT.inr),
        eqTax2:      (R) => f(`MAX(0, ${R.eqGain2} - ${R.ltcgLeft1}) * LTCG_RATE / 100`, NUM_FMT.inr),
        eqNetCash2:  (R) => f(`${R.eqSell2} - ${R.eqTax2}`, NUM_FMT.inr),
        fdEnd:       (R) => f(`${R.fdMid} + ${R.eqNetCash2}`, NUM_FMT.inr),
        eqEnd:       (R) => f(`${R.eqMid} - ${R.eqSell2}`, NUM_FMT.inr),
        eqCostEnd:   (R) => f(`${R.eqCostMid} - ${R.eqCostMid} * IF(${R.eqMid}>0, ${R.eqSell2}/${R.eqMid}, 0) + ${R.harvested}`, NUM_FMT.inr),
      }),
    };
  }

  function strat_swp(inp) {
    /* Arbitrage + SWP — three sub-buckets, mirrors simulateSWP() in app.js.
         • Liquid bucket  : MIN(fdPercent×corpus, 2-yr expenses)  @ 5% post-tax
         • Arbitrage      : remainder of fixed portion             @ 6.5% pre-LTCG
         • Equity         : 1 - fdPercent                          @ EQ_RATE pre-LTCG

       Each year:
         1. Grow all three buckets.
         2. If liquid < cashNeed and arbitrage > 0: redeem arb (LTCG, 1.05 gross-up).
         3. Spend min(cashNeed, liquid) from liquid.
         4. Tri-annual top-up (yr%3=0 OR arb<5×outflow): sell eq to refill arb up
            to 8×outflow (capped by available equity).
         5. Tax-gain harvest the EQUITY bucket first, then arbitrage, using
            whatever LTCG exemption remains.

       Cost basis tracking is REAL — fresh purchases (eq → arb in step 4) add
       fully to cost basis; sales reduce cost basis proportionally; harvesting
       steps up basis tax-free.  Liquid bucket has no cost basis (already-net). */
    const ARB_RATE_DECIMAL = 0.065;   // 6.5% pre-LTCG
    const LIQ_RATE_DECIMAL = 0.05;    // 5% post-tax
    const initFixed  = `CORPUS * FD_PCT / 100`;
    const initLiquid = `MIN(${initFixed}, MONTHLY_EXP * 12 * 2)`;
    const initArb    = `${initFixed} - ${initLiquid}`;
    const initEq     = `CORPUS - ${initFixed}`;

    return {
      title: 'Plan — Low-tax mutual funds',
      subtitle: 'Cash + low-tax funds + stocks, topped up through the year. Usually less tax than a bank deposit.',
      formulas: (yr, rowR, prev) => ({
        /* ── State IN — separate liquid / arb / arbCost / eq / eqCost trackers.
              The "display" fdStart = liquid + arb (combined).
              Note: arb value at year-end = arbRem1 + eqNetCash2 (harvesting only
              steps up COST basis, not value), so arbStart for next year reads
              from those two columns of the previous row. ── */
        liquidStart:  (R) => yr === 1 ? f(`${initLiquid}`, NUM_FMT.inr) : f(`${prev('liquidMid')}`, NUM_FMT.inr),
        arbStart:     (R) => yr === 1 ? f(`${initArb}`,    NUM_FMT.inr) : f(`${prev('arbRem1')} + ${prev('eqNetCash2')}`, NUM_FMT.inr),
        arbCostStart: (R) => yr === 1 ? f(`${initArb}`,    NUM_FMT.inr) : f(`${prev('arbCostEnd')}`, NUM_FMT.inr),
        fdStart:      yr === 1 ? f(`${initFixed}`, NUM_FMT.inr)
                                : f(`${prev('liquidMid')} + ${prev('arbRem1')} + ${prev('eqNetCash2')}`, NUM_FMT.inr),
        eqStart:      yr === 1 ? f(`${initEq}`, NUM_FMT.inr) : f(`${prev('eqEnd')}`, NUM_FMT.inr),
        eqCostStart:  yr === 1 ? f(`${initEq}`, NUM_FMT.inr) : f(`${prev('eqCostEnd')}`, NUM_FMT.inr),

        /* No FD interest income in SWP — bucket growth IS the return. */
        gross:        f(`0`, NUM_FMT.inr),
        expenseGrossUp: 1,                              // unused (no eqSell1 path)

        /* ── Growth ── */
        liquidGrown:  (R) => f(`${R.liquidStart} * (1 + ${LIQ_RATE_DECIMAL})`, NUM_FMT.inr),
        arbGrown:     (R) => f(`${R.arbStart}    * (1 + ${ARB_RATE_DECIMAL})`, NUM_FMT.inr),
        /* eqGrown is the common-headers formula (eqStart * (1 + EQ_RATE/100)). */

        /* ── Step 2: redeem arb if liquid is short.  cashNeed = totalOutflow - pension.
              The 1.05 gross-up is applied to the deficit. ── */
        arbSell1:     (R) => {
          const cashNeed = `MAX(0, ${R.totalOutflow} - ${R.pension})`;
          const deficit  = `MAX(0, ${cashNeed} - ${R.liquidGrown})`;
          return f(`IF(AND(${R.arbGrown}>0, ${deficit}>0), MIN(${deficit} * 1.05, ${R.arbGrown}), 0)`, NUM_FMT.inr);
        },
        arbGain1:     (R) => f(`${R.arbSell1} - ${R.arbCostStart} * IF(${R.arbGrown}>0, ${R.arbSell1}/${R.arbGrown}, 0)`, NUM_FMT.inr),
        arbTax1:      (R) => f(`MAX(0, ${R.arbGain1} - ${R.ltcgFreeInit}) * LTCG_RATE / 100`, NUM_FMT.inr),
        arbNetCash1:  (R) => f(`${R.arbSell1} - ${R.arbTax1}`, NUM_FMT.inr),
        arbRem1:      (R) => f(`${R.arbGrown} - ${R.arbSell1}`, NUM_FMT.inr),
        arbCostRem1:  (R) => f(`${R.arbCostStart} - ${R.arbCostStart} * IF(${R.arbGrown}>0, ${R.arbSell1}/${R.arbGrown}, 0)`, NUM_FMT.inr),

        /* ── Step 3: spend cashNeed from liquid (which now includes arbNetCash1).
              Remaining liquid → liquidMid. ── */
        liquidMid:    (R) => {
          const cashNeed = `MAX(0, ${R.totalOutflow} - ${R.pension})`;
          const liquidPool = `${R.liquidGrown} + ${R.arbNetCash1}`;
          return f(`MAX(0, ${liquidPool} - MIN(${cashNeed}, ${liquidPool}))`, NUM_FMT.inr);
        },

        /* Display-only mid-year columns — keep audit trail consistent. */
        fdMid:        (R) => f(`${R.liquidMid} + ${R.arbRem1}`, NUM_FMT.inr),
        eqMid:        (R) => f(`${R.eqGrown}`, NUM_FMT.inr),
        eqCostMid:    (R) => f(`${R.eqCostStart}`, NUM_FMT.inr),
        arbMid:       (R) => f(`${R.arbRem1}`, NUM_FMT.inr),
        arbCostMid:   (R) => f(`${R.arbCostRem1}`, NUM_FMT.inr),

        /* ── Step 4: tri-annual top-up of arbitrage from equity.
              Trigger: every 3rd year OR if arb < 5×outflow.
              Target : 8×outflow (= floor 5× + extra 3×).
              Sale size = MIN(target - arbRem1, eqGrown).  Cost basis of new arb
              units = the netCash received (fresh purchase). ── */
        rebalFlag:    (R) => fb(`AND(${R.eqMid}>0, OR(MOD(${rowR.yr},3)=0, ${R.arbRem1} < ${R.totalOutflow}*5), ${R.arbRem1} < ${R.totalOutflow}*8)`),
        eqSell2:      (R) => f(`IF(${R.rebalFlag}, MIN(MAX(0, ${R.totalOutflow}*8 - ${R.arbRem1}), ${R.eqMid}), 0)`, NUM_FMT.inr),
        eqGain2:      (R) => f(`${R.eqSell2} - ${R.eqCostMid} * IF(${R.eqMid}>0, ${R.eqSell2}/${R.eqMid}, 0)`, NUM_FMT.inr),
        /* Exemption-left after the arb sale is what's available for the eq sale. */
        eqTax2:       (R) => f(`MAX(0, ${R.eqGain2} - MAX(0, ${R.ltcgFreeInit} - ${R.arbGain1})) * LTCG_RATE / 100`, NUM_FMT.inr),
        eqNetCash2:   (R) => f(`${R.eqSell2} - ${R.eqTax2}`, NUM_FMT.inr),

        /* ── Step 5a: harvested (equity) — uses whatever exemption remains
              after both real sales.  Cost basis steps up by harvested. ── */
        harvestExempLeft: (R) => `MAX(0, ${R.ltcgFreeInit} - ${R.arbGain1} - ${R.eqGain2})`,
        preCostEnd:   (R) => `(${R.eqCostMid} - ${R.eqCostMid} * IF(${R.eqMid}>0, ${R.eqSell2}/${R.eqMid}, 0))`,
        eqCostEnd:    (R) => f(`(${R.eqCostMid} - ${R.eqCostMid} * IF(${R.eqMid}>0, ${R.eqSell2}/${R.eqMid}, 0)) + ${R.harvested}`, NUM_FMT.inr),
        eqEnd:        (R) => f(`${R.eqMid} - ${R.eqSell2}`, NUM_FMT.inr),

        /* ── Step 5b: harvested (arbitrage) — uses exemption left AFTER eq harvest.
              arbCostEnd_pre = arbCostRem1 + eqNetCash2 (fresh purchases add to basis).
              arbCostEnd     = arbCostEnd_pre + harvestedArb. ── */
        harvestedArb: (R) => {
          const arbEndPre   = `(${R.arbRem1} + ${R.eqNetCash2})`;
          const arbCostPre  = `(${R.arbCostRem1} + ${R.eqNetCash2})`;
          const exempLeftEq = `MAX(0, ${R.ltcgFreeInit} - ${R.arbGain1} - ${R.eqGain2})`;
          const exempLeftAfterEq = `MAX(0, ${exempLeftEq} - ${R.harvested})`;
          const unrealisedArb = `${arbEndPre} - ${arbCostPre}`;
          return f(`IF(TAX_HARVEST=1, MAX(0, MIN(${exempLeftAfterEq}, MAX(0, ${unrealisedArb}))), 0)`, NUM_FMT.inr);
        },
        arbCostEnd:   (R) => f(`${R.arbCostRem1} + ${R.eqNetCash2} + ${R.harvestedArb}`, NUM_FMT.inr),

        /* fdEnd display = liquid + arb at year end (post all sales / refills). */
        fdEnd:        (R) => f(`${R.liquidMid} + ${R.arbRem1} + ${R.eqNetCash2}`, NUM_FMT.inr),
      }),
    };
  }

  function strat_annuity(inp) {
    /* Lifetime annuity (RoP variant).  Pays out ANN_RATE(starting age) × CORPUS
       every year, taxed at slab.  Corpus is locked at CORPUS until death
       (returned to heirs).  Buffer accumulates surpluses at 5% (post-tax). */
    return {
      title: 'Plan — Pension for life',
      subtitle: 'An insurance company pays a fixed monthly income for life; the money returns to your family at the end.',
      formulas: (yr, rowR, prev) => ({
        /* fdStart column doubles as "corpus + buffer" for the user; total never
           dips below CORPUS because of the RoP guarantee. */
        fdStart:     yr === 1 ? f(`CORPUS`, NUM_FMT.inr) : f(`${prev('fdEnd')}`, NUM_FMT.inr),
        eqStart:     f(`0`, NUM_FMT.inr),
        eqCostStart: f(`0`, NUM_FMT.inr),
        /* Gross annuity payout uses the *starting age* rate (annuity is set
           at retirement and doesn't change). */
        gross:       f(`CORPUS * ANN_RATE(START_AGE)`, NUM_FMT.inr),
        expenseGrossUp: 1,
        /* Buffer logic: compounds at 5%, surplus adds in, shortfall draws down.
           Total = CORPUS + MAX(0, prev_buffer * 1.05 + (incomeIn - totalOutflow))
           where prev_buffer = (Y1: 0, else: previous fdEnd - CORPUS).
           Inlined (no LET) for compatibility with older Excel / HyperFormula. */
        fdMid:       (R) => {
          const bufferPrev = yr === 1 ? '0' : `(${prev('fdEnd')} - CORPUS)`;
          return f(`CORPUS + MAX(0, ${bufferPrev} * 1.05 + ${R.incomeIn} - ${R.totalOutflow})`, NUM_FMT.inr);
        },
        eqMid:       (R) => f(`0`, NUM_FMT.inr),
        eqCostMid:   (R) => f(`0`, NUM_FMT.inr),
        fdEnd:       (R) => f(`${R.fdMid}`, NUM_FMT.inr),
        eqEnd:       (R) => f(`0`, NUM_FMT.inr),
        eqCostEnd:   (R) => f(`0`, NUM_FMT.inr),
      }),
    };
  }

  /* ────────────────────────────────────────────────────────────────────────
     INFLATION SHEET — milestone monthly need projection.
     ──────────────────────────────────────────────────────────────────────── */
  function buildInflationSheet(XLSX, inp) {
    const rows = [];
    rows.push([s('Inflation projection — what your monthly expense becomes over time')]);
    rows.push([s('Edit the General CPI inflation cell on Inputs to recompute everything.')]);
    rows.push([]);
    rows.push([s('Year'), s('Age'), s('Monthly need (₹)'), s('Annual need (₹)'), s('Factor vs Y1'),
               s('FD net interest (₹)'), s('Coverage')]);
    const milestones = [1, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50].filter(y => y <= inp.maxYears);
    milestones.forEach(yr => {
      const r = {
        yr: cellRef(0, rows.length),
        age: cellRef(1, rows.length),
        monthly: cellRef(2, rows.length),
        annual: cellRef(3, rows.length),
        factor: cellRef(4, rows.length),
        netInt: cellRef(5, rows.length),
        cov: cellRef(6, rows.length),
      };
      rows.push([
        n(yr, NUM_FMT.int),
        f(`START_AGE + ${yr} - 1`, NUM_FMT.int),
        f(`MONTHLY_EXP * (1+INFL/100)^(${yr}-1) * LIFE_MULT(START_AGE + ${yr} - 1)`, NUM_FMT.inr),
        f(`${r.monthly} * 12`, NUM_FMT.inr),
        f(`(1+INFL/100)^(${yr}-1)`, NUM_FMT.mult),
        f(`CORPUS * FD_PCT/100 * FD_RATE/100 - FD_TAX(CORPUS * FD_PCT/100 * FD_RATE/100)`, NUM_FMT.inr),
        f(`${r.annual} / MAX(1, ${r.netInt})`, NUM_FMT.rate2),
      ]);
    });

    const ws = aoaToSheet(XLSX, rows);
    ws['!cols'] = [{ wch: 6 }, { wch: 6 }, { wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 18 }, { wch: 14 }];
    return ws;
  }

  /* ────────────────────────────────────────────────────────────────────────
     SUMMARY SHEET — KPIs side-by-side for every strategy.
     ──────────────────────────────────────────────────────────────────────── */
  function buildSummarySheet(XLSX, inp) {
    const strategies = [
      { key: 'user',     name: 'Half safe, half stocks',      sheet: 'Projection_50_50' },
      { key: 'improved', name: "Senior citizens' scheme",     sheet: 'Projection_SCSS' },
      { key: 'pureFD',   name: 'All in bank deposits',        sheet: 'Projection_PureFD' },
      { key: 'swp',      name: 'Low-tax mutual funds',        sheet: 'Projection_SWP' },
      { key: 'annuity',  name: 'Pension for life',            sheet: 'Projection_Annuity' },
    ];

    const COMMON = COMMON_HEADERS;
    const colForHeader = (h) => col(COMMON.indexOf(h));
    const totalEndCol  = colForHeader('totalEnd');
    const realEndCol   = colForHeader('realEnd');
    const taxCol       = colForHeader('tax');
    const eqTaxYrCol   = colForHeader('eqTaxYr');
    const harvestCol   = colForHeader('harvested');
    const harvestArbCol = colForHeader('harvestedArb');
    const outflowCol   = colForHeader('totalOutflow');
    const rebalCol     = colForHeader('rebalFlag');

    /* Projection data rows live from row 6 (Excel 1-based) to row 6 + MAX_YEARS - 1.
       That's because we put 5 header rows (title, subtitle, computed-note, blank,
       column-headers) before the first year. */
    const dataStart = 6;
    const dataEnd   = (yr) => `${dataStart + inp.maxYears - 1}`;
    const rangeRef = (sheet, c) => `${sheet}!${c}${dataStart}:${c}${dataStart + inp.maxYears - 1}`;

    const rows = [];
    rows.push([s('Plans side by side — taken live from each plan sheet')]);
    rows.push([s('Every cell is a formula. Change anything on the Inputs tab and this table updates.')]);
    rows.push([]);
    rows.push([
      s('Measure'),
      ...strategies.map(st => s(st.name)),
    ]);

    rows.push([
      s('Years it lasts'),
      ...strategies.map(st => f(`COUNTIF(${rangeRef(st.sheet, totalEndCol)}, ">0")`, NUM_FMT.int)),
    ]);
    rows.push([
      s('Money left at end (actual ₹)'),
      ...strategies.map(st => f(`INDEX(${rangeRef(st.sheet, totalEndCol)}, MAX_YEARS)`, NUM_FMT.inr)),
    ]);
    rows.push([
      s("Money left at end (today's value)"),
      ...strategies.map(st => f(`INDEX(${rangeRef(st.sheet, realEndCol)}, MAX_YEARS)`, NUM_FMT.inr)),
    ]);
    rows.push([
      s('Total tax on interest'),
      ...strategies.map(st => f(`SUM(${rangeRef(st.sheet, taxCol)})`, NUM_FMT.inr)),
    ]);
    rows.push([
      s('Total tax on stock profit'),
      ...strategies.map(st => f(`SUM(${rangeRef(st.sheet, eqTaxYrCol)})`, NUM_FMT.inr)),
    ]);
    rows.push([
      s('Total tax'),
      ...strategies.map(st => f(`SUM(${rangeRef(st.sheet, taxCol)}) + SUM(${rangeRef(st.sheet, eqTaxYrCol)})`, NUM_FMT.inr)),
    ]);
    rows.push([
      s('Total profit booked tax-free'),
      ...strategies.map(st => f(`SUM(${rangeRef(st.sheet, harvestCol)}) + SUM(${rangeRef(st.sheet, harvestArbCol)})`, NUM_FMT.inr)),
    ]);
    rows.push([
      s('Tax saved by the yearly tax-saver'),
      ...strategies.map(st => f(`(SUM(${rangeRef(st.sheet, harvestCol)}) + SUM(${rangeRef(st.sheet, harvestArbCol)})) * LTCG_RATE / 100`, NUM_FMT.inr)),
    ]);
    rows.push([
      s('Total spending'),
      ...strategies.map(st => f(`SUM(${rangeRef(st.sheet, outflowCol)})`, NUM_FMT.inr)),
    ]);
    rows.push([
      s('Times moved to safe'),
      ...strategies.map(st => f(`COUNTIF(${rangeRef(st.sheet, rebalCol)}, TRUE)`, NUM_FMT.int)),
    ]);
    rows.push([
      s('Leaves enough for family?'),
      ...strategies.map(st => fb(`INDEX(${rangeRef(st.sheet, realEndCol)}, MAX_YEARS) >= BEQUEST`)),
    ]);

    rows.push([]);
    rows.push([s('Headline (Half safe, half stocks)')]);
    rows.push([s('Years until money runs out (or full plan if it survives)'),
               f(`IF(COUNTIF(${rangeRef('Projection_50_50', totalEndCol)},">0") >= MAX_YEARS, MAX_YEARS, COUNTIF(${rangeRef('Projection_50_50', totalEndCol)},">0"))`, NUM_FMT.int)]);
    rows.push([s('Money runs out at age (blank if it survives)'),
               f(`IF(COUNTIF(${rangeRef('Projection_50_50', totalEndCol)},">0") < MAX_YEARS, START_AGE + COUNTIF(${rangeRef('Projection_50_50', totalEndCol)},">0"), NA())`, NUM_FMT.int)]);

    const ws = aoaToSheet(XLSX, rows);
    ws['!cols'] = [{ wch: 38 }, ...strategies.map(_ => ({ wch: 22 }))];
    return ws;
  }

  /* ────────────────────────────────────────────────────────────────────────
     ALLOCATION SHEET — recommended bucket allocation, formula-driven.
     ──────────────────────────────────────────────────────────────────────── */
  function buildAllocationSheet(XLSX) {
    const rows = [];
    rows.push([s('Recommended allocation — formula-driven from CORPUS, MONTHLY_EXP, SPOUSE')]);
    rows.push([s('Each amount is computed from your Inputs; the bottom row reconciles to CORPUS.')]);
    rows.push([]);
    rows.push([s('Bucket'), s('Instrument'), s('Amount (₹)'), s('Expected return'), s('Tax treatment'), s('% of corpus')]);

    /* Use formula-driven amounts so allocation rebalances if user edits CORPUS / MONTHLY_EXP. */
    const buckets = [
      { bucket: 'Buffer · 0–2 yr expenses',  instr: 'Liquid funds / sweep-in FD',
        amt: 'MIN(MONTHLY_EXP*12*2, CORPUS*0.04)',
        ret: '5–6%', tax: 'Slab on gains' },
      { bucket: 'Income · 3–7 yr',           instr: 'SCSS (₹30 L/spouse, max ₹60 L)',
        amt: 'MIN(IF(SPOUSE=1, 6000000, 3000000), CORPUS*0.10)',
        ret: '8.2%', tax: 'Slab' },
      { bucket: 'Income · 3–7 yr',           instr: 'RBI FRSB 2020',
        amt: 'MIN(5000000, CORPUS*0.08)',
        ret: '8.05% (float)', tax: 'Slab' },
      { bucket: 'Income · 3–7 yr',           instr: 'Bank FD (laddered, 4–6 banks)',
        amt: 'MIN(8000000, CORPUS*0.13)',
        ret: '6.5–7.2%', tax: 'Slab' },
      { bucket: 'Stability · 5–10 yr',       instr: 'Arbitrage / conservative hybrid SWP',
        amt: 'MIN(6600000, CORPUS*0.11)',
        ret: '6–8%', tax: 'Equity (12.5% LTCG)' },
      { bucket: 'Growth · 10+ yr',           instr: 'Equity index / flexi-cap',
        amt: 'MAX(0, CORPUS - (MIN(MONTHLY_EXP*12*2, CORPUS*0.04) + MIN(IF(SPOUSE=1, 6000000, 3000000), CORPUS*0.10) + MIN(5000000, CORPUS*0.08) + MIN(8000000, CORPUS*0.13) + MIN(6600000, CORPUS*0.11)))',
        ret: '10–12%', tax: 'Equity (12.5% LTCG)' },
    ];
    const firstAllocRow = rows.length;
    buckets.forEach((b, i) => {
      const r = rows.length;
      rows.push([
        s(b.bucket), s(b.instr),
        f(b.amt, NUM_FMT.inr),
        s(b.ret), s(b.tax),
        f(`${cellRef(2, r)} / CORPUS`, NUM_FMT.rate2),
      ]);
    });
    const lastAllocRow = rows.length - 1;
    rows.push([
      s('TOTAL'), s(''),
      f(`SUM(${cellRef(2, firstAllocRow)}:${cellRef(2, lastAllocRow)})`, NUM_FMT.inr),
      s(''), s(''),
      f(`SUM(${cellRef(2, firstAllocRow)}:${cellRef(2, lastAllocRow)}) / CORPUS`, NUM_FMT.rate2),
    ]);

    const ws = aoaToSheet(XLSX, rows);
    ws['!cols'] = [{ wch: 30 }, { wch: 38 }, { wch: 18 }, { wch: 16 }, { wch: 24 }, { wch: 12 }];
    return ws;
  }

  /* ────────────────────────────────────────────────────────────────────────
     CHECKS SHEET — TRUE/FALSE balance checks.  Per the xlsx-author convention
     this is the first place to look if anything seems off.
     ──────────────────────────────────────────────────────────────────────── */
  function buildChecksSheet(XLSX, inp) {
    const dataStart = 6;
    const dataEnd   = dataStart + inp.maxYears - 1;
    const COMMON = COMMON_HEADERS;
    const C = (h) => col(COMMON.indexOf(h));

    /* Helper to reference a specific cell on a strategy sheet. */
    const cellOn = (sheet, c, r) => `${sheet}!${c}${r}`;
    const colOn  = (sheet, c) => `${sheet}!${c}${dataStart}:${c}${dataEnd}`;

    const rows = [];
    rows.push([s('Self-test — every row should say TRUE')]);
    rows.push([s("If any row says FALSE, something in the workbook's maths is off — double-check before trusting the numbers.")]);
    rows.push([]);
    rows.push([s('Test'), s('Plan'), s('Result'), s('Should be'), s('What it checks')]);

    /* 1.  Year 1 fdStart on 50/50 = CORPUS × FD_PCT / 100 */
    rows.push([
      s('Y1 FD start = CORPUS × FD%'),
      s('50/50'),
      fb(`ABS(${cellOn('Projection_50_50', C('fdStart'), dataStart)} - CORPUS*FD_PCT/100) < 1`),
      s('TRUE'),
      s('Initial allocation must equal CORPUS × FD%/100.'),
    ]);
    /* 2.  Y1 eqStart on 50/50 = CORPUS × (1 - FD%) */
    rows.push([
      s('Y1 Equity start = CORPUS × (1 − FD%)'),
      s('50/50'),
      fb(`ABS(${cellOn('Projection_50_50', C('eqStart'), dataStart)} - CORPUS*(1-FD_PCT/100)) < 1`),
      s('TRUE'),
      s('Initial equity slice should equal the residual.'),
    ]);
    /* 3.  Pure FD: gross interest = fdStart × FD_RATE */
    rows.push([
      s('Pure FD Y1 gross interest = FD × FD_RATE'),
      s('Pure FD'),
      fb(`ABS(${cellOn('Projection_PureFD', C('gross'), dataStart)} - CORPUS*FD_RATE/100) < 1`),
      s('TRUE'),
      s('Pure FD strategy keeps all the corpus in FD.'),
    ]);
    /* 4.  Annuity: gross payout = CORPUS × ANN_RATE(start_age) for every year */
    rows.push([
      s('Annuity payout = CORPUS × ANN_RATE(start age)'),
      s('Annuity'),
      fb(`ABS(${cellOn('Projection_Annuity', C('gross'), dataStart)} - CORPUS*ANN_RATE(START_AGE)) < 1`),
      s('TRUE'),
      s('LIC Jeevan Akshay-VII (RoP) payout fixed at issue.'),
    ]);
    /* 5.  Annuity corpus never below CORPUS — RoP guarantee */
    rows.push([
      s('Annuity total never < CORPUS (RoP)'),
      s('Annuity'),
      fb(`COUNTIF(${colOn('Projection_Annuity', C('fdEnd'))}, "<" & CORPUS - 1) = 0`),
      s('TRUE'),
      s('Return-of-Purchase-Price guarantees corpus at death.'),
    ]);
    /* 6.  All strategies: realEnd ≤ totalEnd  (real ≤ nominal once inflation > 0) */
    rows.push([
      s('Real corpus ≤ nominal (final year)'),
      s('All'),
      fb(`AND(` +
         `INDEX(${colOn('Projection_50_50', C('realEnd'))}, MAX_YEARS) <= INDEX(${colOn('Projection_50_50', C('totalEnd'))}, MAX_YEARS) + 1,` +
         `INDEX(${colOn('Projection_PureFD', C('realEnd'))}, MAX_YEARS) <= INDEX(${colOn('Projection_PureFD', C('totalEnd'))}, MAX_YEARS) + 1,` +
         `INDEX(${colOn('Projection_SCSS', C('realEnd'))}, MAX_YEARS) <= INDEX(${colOn('Projection_SCSS', C('totalEnd'))}, MAX_YEARS) + 1` +
         `)`),
      s('TRUE'),
      s('Real value is nominal divided by inflation factor ≥ 1.'),
    ]);
    /* 7.  Tax @ 12L = 0 (87A rebate) */
    rows.push([
      s('§87A rebate: tax @ ₹12 L income = 0'),
      s('Tax'),
      fb(`ABS(WITH_SURCHARGE(1200000)) < 1`),
      s('TRUE'),
      s('Income at the rebate ceiling pays zero tax.'),
    ]);
    /* 8.  Tax @ 12L+1 = 4% cess on slab tax (~ ₹52 with marginal relief) */
    rows.push([
      s('Tax @ ₹12.01 L positive but small (marginal relief)'),
      s('Tax'),
      fb(`AND(WITH_SURCHARGE(1201000) > 0, WITH_SURCHARGE(1201000) < 5000)`),
      s('TRUE'),
      s('Marginal relief caps tax at (income − ₹12L), then 4% cess.'),
    ]);
    /* 9.  Allocation TOTAL ties to CORPUS */
    rows.push([
      s('Allocation total = CORPUS'),
      s('Allocation'),
      fb(`ABS(SUM(Allocation!C5:C10) - CORPUS) < 1`),
      s('TRUE'),
      s('Recommended buckets sum to the full corpus.'),
    ]);

    const ws = aoaToSheet(XLSX, rows);
    ws['!cols'] = [{ wch: 50 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 60 }];
    return ws;
  }

  /* ────────────────────────────────────────────────────────────────────────
     README SHEET — explains layout, color convention, and how to edit.
     ──────────────────────────────────────────────────────────────────────── */
  function buildReadmeSheet(XLSX, inp) {
    const rows = [
      [s("Will My Money Last — Retirement Calculator Workbook")],
      [s("Exported on " + new Date().toISOString().slice(0, 10) + " from retirement.techdevix.com")],
      [],
      [s("HOW TO USE")],
      [s("1. Open the 'Inputs' tab and change any number in column B.")],
      [s("2. Every other tab updates by itself.")],
      [s("3. The 'Life_Events' tab is where you add or remove big one-off costs (a wedding, college, a medical bill…).")],
      [s("4. The 'Summary' tab shows all 5 plans side by side.")],
      [s("5. The 'Checks' tab is a self-test — every row should say TRUE.")],
      [],
      [s("GOOD TO KNOW")],
      [s("• You only ever type into the 'Inputs' and 'Life_Events' tabs. Everything else is worked out for you.")],
      [s("• The numbers update live in Excel, Excel on the web, and Google Sheets.")],
      [s("• Tax rates and bands sit on the 'Tax_Tables' tab — change them there if the rules change.")],
      [],
      [s("WHAT'S ON EACH TAB")],
      [s("README        — this page")],
      [s("Inputs        — your numbers (type here, column B)")],
      [s("Life_Events   — your big one-off costs (type here)")],
      [s("Summary       — all 5 plans side by side")],
      [s("Projection_50_50    — Half safe, half stocks, year by year")],
      [s("Projection_SCSS     — Senior citizens' scheme, year by year")],
      [s("Projection_PureFD   — All in bank deposits, year by year")],
      [s("Projection_SWP      — Low-tax mutual funds, year by year")],
      [s("Projection_Annuity  — Pension for life, year by year")],
      [s("Inflation     — how your monthly spending grows over time")],
      [s("Allocation    — a suggested way to split your money")],
      [s("Tax_Tables    — India 2025-26 tax rates (for reference)")],
      [s("Checks        — self-test (everything should say TRUE)")],
      [],
      [s("WHAT'S ALREADY BUILT IN")],
      [s("• India's 2025-26 income-tax rates.")],
      [s("• Income up to ₹12 Lakh a year pays no income tax.")],
      [s("• An extra ₹50,000 tax-free on interest for people aged 60+.")],
      [s("• Higher taxes on very high incomes.")],
      [s("• 12.5% tax on stock profit, with ₹1.25 Lakh a year tax-free (₹2.5 Lakh as a couple).")],
      [s("• The free yearly tax-saver (when turned on) — sell a little stock and buy it back to use the tax-free limit.")],
      [s("• Senior citizens' scheme at 8.2% (up to ₹30 Lakh each).")],
      [s("• Pension-for-life rates: about 5.8 / 6.2 / 6.5 / 7.2 / 8.0% at ages under 60 / 60 / 65 / 70 / 75+.")],
      [],
      [s("WHAT THIS WORKBOOK DOESN'T DO")],
      [s("• The 'luck test' (random good and bad market years) — that's on the website only.")],
      [s("• Sudden market crashes — here the stock market grows by a steady, average amount.")],
      [s("• Changes to tax rules later — today's rates are used throughout.")],
      [],
      [s("Made with Will My Money Last — https://retirement.techdevix.com")],
    ];
    const ws = aoaToSheet(XLSX, rows);
    ws['!cols'] = [{ wch: 96 }];
    return ws;
  }

  /* ────────────────────────────────────────────────────────────────────────
     buildWorkbook — assembles everything.
     ──────────────────────────────────────────────────────────────────────── */
  function buildWorkbook(inputs) {
    const XLSX = window.XLSX;
    if (!XLSX) throw new Error('SheetJS (XLSX) library not loaded.');

    const wb = XLSX.utils.book_new();

    /* Build the data sheets, then the projection sheets so cross-sheet refs resolve. */
    const inputsBuilt   = buildInputsSheet(XLSX, inputs);
    const eventsBuilt   = buildLifeEventsSheet(XLSX, inputs);
    const taxBuilt      = buildTaxTablesSheet(XLSX);

    /* Project sheets need Inputs / Tax_Tables / Life_Events named ranges in scope. */
    const proj5050   = buildProjection(XLSX, 'Projection_50_50',   inputs, strat_5050(inputs));
    const projScss   = buildProjection(XLSX, 'Projection_SCSS',    inputs, strat_scss(inputs));
    const projPure   = buildProjection(XLSX, 'Projection_PureFD',  inputs, strat_pureFD(inputs));
    const projSwp    = buildProjection(XLSX, 'Projection_SWP',     inputs, strat_swp(inputs));
    const projAnn    = buildProjection(XLSX, 'Projection_Annuity', inputs, strat_annuity(inputs));

    const inflation  = buildInflationSheet(XLSX, inputs);
    const summary    = buildSummarySheet(XLSX, inputs);
    const allocation = buildAllocationSheet(XLSX);
    const checks     = buildChecksSheet(XLSX, inputs);
    const readme     = buildReadmeSheet(XLSX, inputs);

    /* Sheet ordering — READMEfirst, reference sheets last. */
    XLSX.utils.book_append_sheet(wb, readme,             'README');
    XLSX.utils.book_append_sheet(wb, inputsBuilt.sheet,  'Inputs');
    XLSX.utils.book_append_sheet(wb, eventsBuilt.sheet,  'Life_Events');
    XLSX.utils.book_append_sheet(wb, summary,            'Summary');
    XLSX.utils.book_append_sheet(wb, proj5050,           'Projection_50_50');
    XLSX.utils.book_append_sheet(wb, projScss,           'Projection_SCSS');
    XLSX.utils.book_append_sheet(wb, projPure,           'Projection_PureFD');
    XLSX.utils.book_append_sheet(wb, projSwp,            'Projection_SWP');
    XLSX.utils.book_append_sheet(wb, projAnn,            'Projection_Annuity');
    XLSX.utils.book_append_sheet(wb, inflation,          'Inflation');
    XLSX.utils.book_append_sheet(wb, allocation,         'Allocation');
    XLSX.utils.book_append_sheet(wb, taxBuilt.sheet,     'Tax_Tables');
    XLSX.utils.book_append_sheet(wb, checks,             'Checks');

    /* Defined names (named ranges + LAMBDAs).
       CRITICAL: SheetJS only serialises defined names whose keys are CAPITALISED
       ({Name, Ref}); lowercase {name, ref} are silently dropped, leaving every
       formula as #NAME? in Excel/Sheets.  We therefore normalise here.  LAMBDA
       refs are additionally run through xlfnify() so Excel 365 recognises
       LAMBDA / LET and their bound variables. */
    const rangeNames = [
      ...inputsBuilt.names,
      ...eventsBuilt.names,
      ...taxBuilt.names,
    ].map(d => ({ Name: d.name, Ref: d.ref }));
    const lambdaNames = buildLambdas().map(d => ({ Name: d.name, Ref: xlfnify(d.ref, d.vars) }));
    wb.Workbook = { Names: [...rangeNames, ...lambdaNames] };

    return wb;
  }

  /* Export to global scope so app.js can call us once the library is loaded. */
  window.RetirementXLSX = { build: buildWorkbook };
})();
