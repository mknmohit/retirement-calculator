/*!
 * Will My Money Last - Retirement Calculator India
 * Application logic (extracted from inline <script> to enable caching and defer execution)
 * No SEO impact - all SEO content (meta tags, JSON-LD, microdata) remains in HTML.
 * Loaded with `defer` to avoid render-blocking; runs after DOM is parsed.
 */

/* ════════════════════════════════════════════════════════════════════════
   STATE & DEFAULTS
   ════════════════════════════════════════════════════════════════════════ */
const DEFAULTS = {
  // Corpus & allocation
  totalCorpus: 60000000,
  fdPercent: 50,
  // Returns
  fdRate: 6.5,
  equityRate: 12,
  equityVolatility: 18,           // annualised σ of Nifty ~18-22% historically
  // Inflation
  inflation: 6,
  healthInflation: 12,            // healthcare inflates faster than CPI in India
  // Personal
  startingAge: 30,
  isSenior: false,
  spouse: false,                  // joint planning: SCSS limit doubles, optional
  spouseAge: 58,
  // Income
  monthlyExpense: 100000,
  healthInsuranceAnnual: 60000,
  pensionAnnual: 0,               // pension or rental, separate income
  pensionInflated: true,
  otherIncome: 0,                 // taxable other income (already in tax calc)
  // Lifestyle by age (multipliers on base monthly expense)
  lifestyleMid: 0.95,             // age 65-75: typically slightly less
  lifestyleOld: 1.15,             // age 75+: more care, domestic help
  // Tax
  taxMode: 'slab',
  flatTaxRate: 30,
  // Goals
  bequestGoal: 0,                 // amount you want to leave behind (today's ₹)
  // Simulation
  maxYears: 50,
  mcRuns: 500,                    // Monte Carlo runs
  // Tax constants
  ltcgRate: 12.5,
  ltcgExemption: 125000,
  // One-off life events — typical for a 60-yr-old with grown children
  events: [
    { id: 1, year: 4, amount: 2500000, label: "Child's higher education" },
    { id: 2, year: 8, amount: 4000000, label: "Child's wedding" },
    { id: 3, year: 12, amount: 1500000, label: 'Car replacement' },
    { id: 4, year: 15, amount: 2000000, label: 'International family trip' },
  ],
};

const PRESETS = {
  base:         { ...DEFAULTS },
  conservative: { ...DEFAULTS, equityRate: 8, inflation: 7 },
  optimistic:   { ...DEFAULTS, equityRate: 14, inflation: 5 },
  stress:       { ...DEFAULTS, equityRate: 6, inflation: 8, monthlyExpense: 125000, healthInflation: 14 },
  lean:         { ...DEFAULTS, monthlyExpense: 75000, events: [] },
  fat:          { ...DEFAULTS, monthlyExpense: 200000 },
  couple:       { ...DEFAULTS, monthlyExpense: 140000, spouse: true, isSenior: true, healthInsuranceAnnual: 120000 },
  bigEvents:    { ...DEFAULTS, events: [
    { id: 1, year: 3, amount: 3500000, label: "Son's MBA abroad" },
    { id: 2, year: 6, amount: 5000000, label: "Daughter's wedding" },
    { id: 3, year: 10, amount: 1500000, label: 'Hospitalisation reserve' },
  ]},
};

const state = {
  inputs: loadSavedState() || { ...DEFAULTS },
  activeStrategy: 'user',
  darkMode: matchMedia('(prefers-color-scheme: dark)').matches,
};

/* ════════════════════════════════════════════════════════════════════════
   FORMATTERS
   ════════════════════════════════════════════════════════════════════════ */
function fmtCr(n) {
  if (!isFinite(n)) return '—';
  const cr = n / 1e7;
  if (Math.abs(cr) >= 1) return '₹' + cr.toFixed(2) + ' Cr';
  const L = n / 1e5;
  if (Math.abs(L) >= 1) return '₹' + L.toFixed(2) + ' L';
  return '₹' + Math.round(n).toLocaleString('en-IN');
}
function fmtCrShort(n) {
  if (!isFinite(n)) return '—';
  const cr = n / 1e7;
  if (Math.abs(cr) >= 1) return '₹' + cr.toFixed(1) + 'Cr';
  const L = n / 1e5;
  if (Math.abs(L) >= 1) return '₹' + L.toFixed(1) + 'L';
  return '₹' + Math.round(n / 1000) + 'K';
}
function fmtL(n) {
  if (!isFinite(n)) return '—';
  const L = n / 1e5;
  if (Math.abs(L) >= 0.5) return '₹' + L.toFixed(2) + ' L';
  return '₹' + Math.round(n).toLocaleString('en-IN');
}
function pct(n, d = 1) { return n.toFixed(d) + '%'; }
function inINR(n) {
  return '₹' + Math.round(n).toLocaleString('en-IN');
}

/* ════════════════════════════════════════════════════════════════════════
   TAX HELPERS (FY 2025-26 New Regime)
   ════════════════════════════════════════════════════════════════════════ */
const SLAB_TABLE = [
  [0,        400000,   0],
  [400000,   800000,   0.05],
  [800000,   1200000,  0.10],
  [1200000,  1600000,  0.15],
  [1600000,  2000000,  0.20],
  [2000000,  2400000,  0.25],
  [2400000,  Infinity, 0.30],
];

/** Tax after slab schedule + 87A rebate / marginal relief, BEFORE surcharge and cess. */
function preSurchargeTax(inc) {
  if (inc <= 0) return 0;
  let t = 0;
  for (const [lo, hi, r] of SLAB_TABLE) {
    if (inc > lo) t += (Math.min(inc, hi) - lo) * r;
  }
  if (inc <= 1200000) return 0;                 // §87A rebate (New Regime, ≤ ₹12 L)
  const above = inc - 1200000;
  if (t > above) t = above;                     // §87A marginal relief
  return t;
}

function computeSlabTax(income, isSenior) {
  let inc = income;
  if (isSenior) inc = Math.max(0, inc - 50000);  // Section 80TTB
  if (inc <= 0) return 0;

  let tax = preSurchargeTax(inc);

  // Surcharge with marginal relief at each threshold (New Regime caps at 25%).
  // Marginal-relief rule: (tax + surcharge) at income X cannot exceed
  // (tax + surcharge at the threshold) + (X − threshold).
  let surcharge = 0;
  if (inc > 20000000) {
    surcharge = tax * 0.25;
    const ceiling = preSurchargeTax(20000000) * 1.15 + (inc - 20000000);
    if (tax + surcharge > ceiling) surcharge = Math.max(0, ceiling - tax);
  } else if (inc > 10000000) {
    surcharge = tax * 0.15;
    const ceiling = preSurchargeTax(10000000) * 1.10 + (inc - 10000000);
    if (tax + surcharge > ceiling) surcharge = Math.max(0, ceiling - tax);
  } else if (inc > 5000000) {
    surcharge = tax * 0.10;
    const ceiling = preSurchargeTax(5000000) + (inc - 5000000);
    if (tax + surcharge > ceiling) surcharge = Math.max(0, ceiling - tax);
  }
  tax += surcharge;
  tax *= 1.04;                                  // Health & Education Cess (4%)
  return tax;
}

/** Effective annual LTCG exemption — doubles when both spouses file separately. */
function yearlyLtcgExemption(inp) {
  return (inp.spouse ? 2 : 1) * inp.ltcgExemption;
}

function fdTaxOn(grossInterest, inp = state.inputs) {
  if (inp.taxMode === 'flat') return grossInterest * inp.flatTaxRate / 100;
  const otherInc = inp.otherIncome || 0;
  // Spouse tax splitting: realistic if each spouse holds half the income-producing
  // assets (own SCSS slot, own FDs from their pre-retirement savings). Doubles
  // every threshold — most powerfully the ₹12 L 87A rebate.
  if (inp.spouse) {
    const halfInt = grossInterest / 2, halfOther = otherInc / 2;
    const each = Math.max(0, computeSlabTax(halfInt + halfOther, inp.isSenior) - computeSlabTax(halfOther, inp.isSenior));
    return each * 2;
  }
  const taxWith = computeSlabTax(grossInterest + otherInc, inp.isSenior);
  const taxWithout = computeSlabTax(otherInc, inp.isSenior);
  return Math.max(0, taxWith - taxWithout);
}

/**
 * Sell `amount` worth of equity (proportional cost-basis). LTCG is computed on the
 * realised gain after applying `exemption` — pass the *remaining* per-year exemption
 * so that multiple sales within the same year share the single ₹1.25 L allowance.
 * If `exemption` is omitted the full yearly exemption is used (single-sale callers).
 */
function withdrawEquity(value, cost, amount, inp = state.inputs, exemption) {
  if (value <= 0 || amount <= 0) {
    return { netCash: 0, tax: 0, rv: value, rc: cost, gain: 0 };
  }
  const sell = Math.min(amount, value);
  const frac = sell / value;
  const costSold = cost * frac;
  const gain = sell - costSold;
  const eff = (exemption === undefined) ? yearlyLtcgExemption(inp) : Math.max(0, exemption);
  const taxable = Math.max(0, gain - eff);
  const tax = taxable * inp.ltcgRate / 100;
  return { netCash: sell - tax, tax, rv: value - sell, rc: cost - costSold, gain };
}

/* ════════════════════════════════════════════════════════════════════════
   SIMULATIONS — four strategies
   ════════════════════════════════════════════════════════════════════════ */
/* Compute the "events expense" for a given simulation year. */
function eventsInYear(inp, yr) {
  if (!inp.events || !inp.events.length) return { total: 0, items: [] };
  const items = inp.events.filter(e => e.year === yr && e.amount > 0);
  return { total: items.reduce((s, e) => s + e.amount, 0), items };
}

/* Lifestyle multiplier for the given age. */
function lifestyleMult(inp, age) {
  if (age >= 75) return inp.lifestyleOld;
  if (age >= 65) return inp.lifestyleMid;
  return 1.0;
}

/**
 * Core year-by-year engine. Implements the user's strategy.
 * @param {Object} inp - inputs
 * @param {Object} [opts] - { equityReturnFn(yr) -> number to override flat return for MC }
 */
function simulateUserStrategy(inp = state.inputs, opts = {}) {
  let fd = inp.totalCorpus * inp.fdPercent / 100;
  let eq = inp.totalCorpus - fd;
  let eqCost = eq;
  let baseAnnualExp = inp.monthlyExpense * 12;
  let health = inp.healthInsuranceAnnual;
  let pension = inp.pensionAnnual || 0;

  const years = [];
  let totalFDTax = 0, totalEqTax = 0, totalSpent = 0, rebalances = 0;
  let inflationFactor = 1;
  let totalEvents = 0;

  for (let yr = 1; yr <= inp.maxYears; yr++) {
    const fdStart = fd, eqStart = eq;
    const age = inp.startingAge + yr - 1;
    const lMult = lifestyleMult(inp, age);
    const annualExp = baseAnnualExp * lMult;
    const monthlyAtThisYr = annualExp / 12;
    const { total: eventOut, items: eventItems } = eventsInYear(inp, yr);
    totalEvents += eventOut;

    const gross = fd * inp.fdRate / 100;
    const tax = fdTaxOn(gross, inp);
    const net = gross - tax;
    totalFDTax += tax;

    const eqReturn = opts.equityReturnFn ? opts.equityReturnFn(yr) : inp.equityRate / 100;
    eq = eq * (1 + eqReturn);

    const totalOutflow = annualExp + health + eventOut;
    const incomeIn = net + pension;
    let fdDraw = 0, eqTaxThisYr = 0, surplus = 0;
    // LTCG ₹1.25 L exemption is per filer per FY — shared across all equity sales in the year.
    let exemptionLeft = yearlyLtcgExemption(inp);

    if (incomeIn >= totalOutflow) {
      surplus = incomeIn - totalOutflow;
      fd += surplus;
      totalSpent += totalOutflow;
    } else {
      const need = totalOutflow - incomeIn;
      fdDraw = Math.min(need, fd);
      fd -= fdDraw;
      totalSpent += incomeIn + fdDraw;
      const still = need - fdDraw;
      if (still > 0 && eq > 0) {
        const r = withdrawEquity(eq, eqCost, still * 1.15, inp, exemptionLeft);
        eq = r.rv; eqCost = r.rc;
        exemptionLeft = Math.max(0, exemptionLeft - r.gain);
        totalEqTax += r.tax; eqTaxThisYr += r.tax;
        // Spend exactly `still`; any over-sale proceeds (gross-up buffer) park in FD.
        const used = Math.min(r.netCash, still);
        totalSpent += used;
        fd += (r.netCash - used);
      }
    }

    let rebalanced = false;
    if (fdStart > 5000 && fd < 5000 && eq > 0) {
      const half = eq / 2;
      const r = withdrawEquity(eq, eqCost, half, inp, exemptionLeft);
      fd = r.netCash; eq = r.rv; eqCost = r.rc;
      exemptionLeft = Math.max(0, exemptionLeft - r.gain);
      totalEqTax += r.tax; eqTaxThisYr += r.tax;
      rebalances++; rebalanced = true;
    }

    inflationFactor *= (1 + inp.inflation / 100);
    const total = Math.max(0, fd + eq);
    // Withdrawal rate = total spending / start-of-year corpus, directly comparable to the 4% rule.
    const withdrawalRate = totalOutflow / Math.max(1, fdStart + eqStart);

    years.push({
      yr, age,
      fdStart, eqStart, gross, tax, net,
      pension, expense: annualExp, health, eventOut, eventItems, totalOutflow,
      monthlyExpense: monthlyAtThisYr,
      fdDraw, surplus,
      fdEnd: Math.max(0, fd), eqEnd: Math.max(0, eq),
      total, real: total / inflationFactor,
      rebalanced, eqTax: eqTaxThisYr,
      lifestyleMult: lMult,
      withdrawalRate,
      eqReturn,
    });

    baseAnnualExp *= (1 + inp.inflation / 100);
    health *= (1 + (inp.healthInflation || 12) / 100);
    if (inp.pensionInflated) pension *= (1 + inp.inflation / 100);

    if (total <= 0) break;
  }

  return makeResult(years, { totalFDTax, totalEqTax, totalSpent, rebalances, totalEvents }, inp);
}

function simulateImproved(inp = state.inputs, opts = {}) {
  const scssMax = inp.spouse ? 6000000 : 3000000;  // spouse doubles limit
  let fixed = inp.totalCorpus * inp.fdPercent / 100;
  let scss = Math.min(scssMax, fixed);
  let fd = fixed - scss;
  let eq = inp.totalCorpus - fixed;
  let eqCost = eq;
  let baseAnnualExp = inp.monthlyExpense * 12;
  let health = inp.healthInsuranceAnnual;
  let pension = inp.pensionAnnual || 0;

  const years = [];
  let totalFDTax = 0, totalEqTax = 0, totalSpent = 0, rebalances = 0;
  let inflationFactor = 1;
  let totalEvents = 0;
  const floorYears = 5;

  for (let yr = 1; yr <= inp.maxYears; yr++) {
    const fdStart = fd + scss, eqStart = eq;
    const age = inp.startingAge + yr - 1;
    const lMult = lifestyleMult(inp, age);
    const annualExp = baseAnnualExp * lMult;
    const { total: eventOut, items: eventItems } = eventsInYear(inp, yr);
    totalEvents += eventOut;

    const scssInt = scss * 8.2 / 100;
    const fdInt = fd * inp.fdRate / 100;
    const gross = scssInt + fdInt;
    const tax = fdTaxOn(gross, inp);
    const net = gross - tax;
    totalFDTax += tax;

    const eqReturn = opts.equityReturnFn ? opts.equityReturnFn(yr) : inp.equityRate / 100;
    eq = eq * (1 + eqReturn);

    const totalOutflow = annualExp + health + eventOut;
    const incomeIn = net + pension;
    let fdDraw = 0, eqTaxThisYr = 0, surplus = 0;
    // Per-year shared LTCG exemption (doubled for spouse).
    let exemptionLeft = yearlyLtcgExemption(inp);

    if (incomeIn >= totalOutflow) {
      surplus = incomeIn - totalOutflow; fd += surplus;
      totalSpent += totalOutflow;
    } else {
      const need = totalOutflow - incomeIn;
      fdDraw = Math.min(need, fd);
      fd -= fdDraw;
      totalSpent += incomeIn + fdDraw;
      const still = need - fdDraw;
      if (still > 0 && eq > 0) {
        const r = withdrawEquity(eq, eqCost, still * 1.05, inp, exemptionLeft);
        eq = r.rv; eqCost = r.rc;
        exemptionLeft = Math.max(0, exemptionLeft - r.gain);
        totalEqTax += r.tax; eqTaxThisYr += r.tax;
        const used = Math.min(r.netCash, still);
        totalSpent += used;
        fd += (r.netCash - used);
      }
    }

    // Annual top-up — cap the sale so realised gain ≤ remaining exemption in early years.
    const desired = totalOutflow * floorYears;
    if (fd < desired && eq > 0) {
      const target = desired - fd;
      const valueOverCost = eq > 0 ? Math.max(0, 1 - eqCost / eq) : 0;
      let smart = target;
      if (valueOverCost > 0.01 && yr <= 8) {
        const tipToExemption = exemptionLeft / valueOverCost;
        smart = Math.min(target, tipToExemption);
      }
      if (smart > 0) {
        const r = withdrawEquity(eq, eqCost, smart, inp, exemptionLeft);
        fd += r.netCash; eq = r.rv; eqCost = r.rc;
        exemptionLeft = Math.max(0, exemptionLeft - r.gain);
        totalEqTax += r.tax; eqTaxThisYr += r.tax;
        if (smart >= 50000) rebalances++;
      }
    }

    inflationFactor *= (1 + inp.inflation / 100);
    const total = Math.max(0, fd + scss + eq);
    const withdrawalRate = totalOutflow / Math.max(1, fdStart + eqStart);

    years.push({
      yr, age,
      fdStart, eqStart, gross, tax, net,
      pension, expense: annualExp, health, eventOut, eventItems, totalOutflow,
      monthlyExpense: annualExp / 12,
      fdDraw, surplus,
      fdEnd: Math.max(0, fd + scss), eqEnd: Math.max(0, eq),
      total, real: total / inflationFactor,
      rebalanced: false, eqTax: eqTaxThisYr,
      lifestyleMult: lMult, withdrawalRate, eqReturn,
    });

    baseAnnualExp *= (1 + inp.inflation / 100);
    health *= (1 + (inp.healthInflation || 12) / 100);
    if (inp.pensionInflated) pension *= (1 + inp.inflation / 100);
    if (total <= 0) break;
  }

  return makeResult(years, { totalFDTax, totalEqTax, totalSpent, rebalances, totalEvents }, inp);
}

function simulatePureFD(inp = state.inputs) {
  let fd = inp.totalCorpus;
  let baseAnnualExp = inp.monthlyExpense * 12;
  let health = inp.healthInsuranceAnnual;
  let pension = inp.pensionAnnual || 0;
  const years = [];
  let totalFDTax = 0, totalSpent = 0, totalEvents = 0;
  let inflationFactor = 1;

  for (let yr = 1; yr <= inp.maxYears; yr++) {
    const fdStart = fd;
    const age = inp.startingAge + yr - 1;
    const lMult = lifestyleMult(inp, age);
    const annualExp = baseAnnualExp * lMult;
    const { total: eventOut, items: eventItems } = eventsInYear(inp, yr);
    totalEvents += eventOut;

    const gross = fd * inp.fdRate / 100;
    const tax = fdTaxOn(gross, inp);
    const net = gross - tax;
    totalFDTax += tax;

    let fdDraw = 0, surplus = 0;
    const totalOutflow = annualExp + health + eventOut;
    const incomeIn = net + pension;
    if (incomeIn >= totalOutflow) { surplus = incomeIn - totalOutflow; fd += surplus; totalSpent += totalOutflow; }
    else { fdDraw = Math.min(totalOutflow - incomeIn, fd); fd -= fdDraw; totalSpent += incomeIn + fdDraw; }

    inflationFactor *= (1 + inp.inflation / 100);
    const total = Math.max(0, fd);
    const withdrawalRate = totalOutflow / Math.max(1, fdStart);

    years.push({
      yr, age,
      fdStart, eqStart: 0, gross, tax, net,
      pension, expense: annualExp, health, eventOut, eventItems, totalOutflow,
      monthlyExpense: annualExp / 12,
      fdDraw, surplus,
      fdEnd: Math.max(0, fd), eqEnd: 0,
      total, real: total / inflationFactor,
      rebalanced: false, eqTax: 0,
      lifestyleMult: lMult, withdrawalRate, eqReturn: 0,
    });
    baseAnnualExp *= (1 + inp.inflation / 100);
    health *= (1 + (inp.healthInflation || 12) / 100);
    if (inp.pensionInflated) pension *= (1 + inp.inflation / 100);
    if (fd <= 0) break;
  }
  return makeResult(years, { totalFDTax, totalEqTax: 0, totalSpent, rebalances: 0, totalEvents }, inp);
}

function simulateSWP(inp = state.inputs, opts = {}) {
  let liquid = Math.min(inp.totalCorpus * inp.fdPercent / 100, inp.monthlyExpense * 12 * 2);
  let arbitrage = inp.totalCorpus * inp.fdPercent / 100 - liquid;
  let arbCost = arbitrage;
  let eq = inp.totalCorpus - liquid - arbitrage;
  let eqCost = eq;
  let baseAnnualExp = inp.monthlyExpense * 12;
  let health = inp.healthInsuranceAnnual;
  let pension = inp.pensionAnnual || 0;
  const arbRate = 6.5, liquidRate = 5;
  const years = [];
  let totalFDTax = 0, totalEqTax = 0, totalSpent = 0, rebalances = 0;
  let inflationFactor = 1;
  let totalEvents = 0;

  for (let yr = 1; yr <= inp.maxYears; yr++) {
    const fdStart = liquid + arbitrage;
    const eqStart = eq;
    const age = inp.startingAge + yr - 1;
    const lMult = lifestyleMult(inp, age);
    const annualExp = baseAnnualExp * lMult;
    const { total: eventOut, items: eventItems } = eventsInYear(inp, yr);
    totalEvents += eventOut;

    liquid *= (1 + liquidRate / 100);
    arbitrage *= (1 + arbRate / 100);
    const eqReturn = opts.equityReturnFn ? opts.equityReturnFn(yr) : inp.equityRate / 100;
    eq *= (1 + eqReturn);

    const totalOutflow = annualExp + health + eventOut;
    const cashNeed = Math.max(0, totalOutflow - pension);
    let eqTaxThisYr = 0;
    // Both arbitrage and equity are LTCG-taxed (arbitrage funds are ≥65% equity).
    // The ₹1.25 L exemption is shared across all such sales within a year.
    let exemptionLeft = yearlyLtcgExemption(inp);

    if (liquid < cashNeed && arbitrage > 0) {
      const grossNeed = cashNeed - liquid;
      const r = withdrawEquity(arbitrage, arbCost, grossNeed * 1.05, inp, exemptionLeft);
      arbitrage = r.rv; arbCost = r.rc; liquid += r.netCash;
      exemptionLeft = Math.max(0, exemptionLeft - r.gain);
      totalEqTax += r.tax; eqTaxThisYr += r.tax;
    }

    const spent = Math.min(cashNeed, liquid);
    liquid -= spent;
    totalSpent += spent + Math.min(pension, totalOutflow);

    const arbFloor = totalOutflow * 5;
    if ((yr % 3 === 0 || arbitrage < arbFloor) && eq > 0) {
      const target = arbFloor + totalOutflow * 3;
      if (arbitrage < target) {
        const r = withdrawEquity(eq, eqCost, target - arbitrage, inp, exemptionLeft);
        eq = r.rv; eqCost = r.rc;
        arbitrage += r.netCash; arbCost += r.netCash;
        exemptionLeft = Math.max(0, exemptionLeft - r.gain);
        totalEqTax += r.tax; eqTaxThisYr += r.tax;
        rebalances++;
      }
    }

    inflationFactor *= (1 + inp.inflation / 100);
    const total = Math.max(0, liquid + arbitrage + eq);
    const withdrawalRate = totalOutflow / Math.max(1, fdStart + eqStart);

    years.push({
      yr, age,
      fdStart, eqStart, gross: 0, tax: 0, net: 0,
      pension, expense: annualExp, health, eventOut, eventItems, totalOutflow,
      monthlyExpense: annualExp / 12,
      fdDraw: 0, surplus: 0,
      fdEnd: Math.max(0, liquid + arbitrage), eqEnd: Math.max(0, eq),
      total, real: total / inflationFactor,
      rebalanced: false, eqTax: eqTaxThisYr,
      lifestyleMult: lMult, withdrawalRate, eqReturn,
    });
    baseAnnualExp *= (1 + inp.inflation / 100);
    health *= (1 + (inp.healthInflation || 12) / 100);
    if (inp.pensionInflated) pension *= (1 + inp.inflation / 100);
    if (total <= 0) break;
  }

  return makeResult(years, { totalFDTax, totalEqTax, totalSpent, rebalances, totalEvents }, inp);
}

/**
 * Annuity-only strategy — convert entire corpus into an immediate annuity
 * at LIC Jeevan Akshay-VII rate. Rate varies by age: roughly
 *   60 yr: ~6.2% (Option F), 65 yr: ~6.5%, 70 yr: ~7.2% (return of purchase price).
 * Without return of purchase price it is higher (~7.5-9%) but corpus dies with you.
 * Here we model the with-RoP variant since most retirees pick it.
 */
function simulateAnnuity(inp = state.inputs) {
  const annuityRate = annuityRateFor(inp.startingAge);
  const annualPayout = inp.totalCorpus * annuityRate / 100;
  let baseAnnualExp = inp.monthlyExpense * 12;
  let health = inp.healthInsuranceAnnual;
  let pension = inp.pensionAnnual || 0;
  const years = [];
  let totalFDTax = 0, totalSpent = 0, totalEvents = 0;
  let inflationFactor = 1;
  let shortfallAccum = 0;
  let buffer = 0;  // any excess accumulates as buffer (kept in liquid, ~5%)

  for (let yr = 1; yr <= inp.maxYears; yr++) {
    const age = inp.startingAge + yr - 1;
    const lMult = lifestyleMult(inp, age);
    const annualExp = baseAnnualExp * lMult;
    const { total: eventOut, items: eventItems } = eventsInYear(inp, yr);
    totalEvents += eventOut;

    const gross = annualPayout;
    const tax = fdTaxOn(gross, inp);
    const net = gross - tax;
    totalFDTax += tax;

    const totalOutflow = annualExp + health + eventOut;
    // Buffer compounds at ~5% (post-tax) — its interest stays in the buffer.
    // Treating it as income earlier double-counted the 5% (once as cash, once as growth).
    const startBuffer = buffer;
    buffer *= 1.05;
    const incomeIn = net + pension;
    let surplus = 0, shortfall = 0, fromBuffer = 0;
    if (incomeIn >= totalOutflow) {
      surplus = incomeIn - totalOutflow;
      buffer += surplus;
      totalSpent += totalOutflow;
    } else {
      shortfall = totalOutflow - incomeIn;
      fromBuffer = Math.min(shortfall, buffer);
      buffer -= fromBuffer;
      const stillShort = shortfall - fromBuffer;
      shortfallAccum += stillShort;
      totalSpent += incomeIn + fromBuffer;
    }

    inflationFactor *= (1 + inp.inflation / 100);
    // Corpus locked in annuity — at death returns purchase price (modeled as final value).
    const total = inp.totalCorpus + buffer;
    const startCorpus = inp.totalCorpus + startBuffer;
    years.push({
      yr, age,
      fdStart: inp.totalCorpus, eqStart: 0, gross, tax, net,
      pension, expense: annualExp, health, eventOut, eventItems, totalOutflow,
      monthlyExpense: annualExp / 12,
      fdDraw: fromBuffer, surplus,
      fdEnd: total, eqEnd: 0,
      total, real: total / inflationFactor,
      rebalanced: false, eqTax: 0,
      lifestyleMult: lMult,
      withdrawalRate: totalOutflow / Math.max(1, startCorpus),
      eqReturn: 0,
      annuityRate, shortfall,
    });
    baseAnnualExp *= (1 + inp.inflation / 100);
    health *= (1 + (inp.healthInflation || 12) / 100);
    if (inp.pensionInflated) pension *= (1 + inp.inflation / 100);
  }
  const r = makeResult(years, { totalFDTax, totalEqTax: 0, totalSpent, rebalances: 0, totalEvents }, inp);
  r.annuityRate = annuityRate;
  r.shortfallAccum = shortfallAccum;
  // Override yearsLasted: annuity corpus doesn't deplete (RoP returns it at death).
  r.yearsLasted = inp.maxYears;
  r.finalCorpus = inp.totalCorpus + (years[years.length - 1]?.fdEnd - inp.totalCorpus || 0);
  return r;
}

function annuityRateFor(age) {
  if (age >= 75) return 8.0;
  if (age >= 70) return 7.2;
  if (age >= 65) return 6.5;
  if (age >= 60) return 6.2;
  return 5.8;
}

/* ── Monte Carlo: equity returns sampled from N(μ, σ) each year ── */
function sampleNormal(mean, std) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + z * std;
}

function runMonteCarlo(inp = state.inputs, runs = inp.mcRuns || 500) {
  const sigma = (inp.equityVolatility || 18) / 100;
  const mu = inp.equityRate / 100;
  const horizon = inp.maxYears;
  const trajReal = [];
  const yearsLastedArr = [];
  const finalRealArr = [];
  let successCount = 0;
  const bequest = inp.bequestGoal || 0;

  for (let i = 0; i < runs; i++) {
    const sim = simulateUserStrategy(inp, {
      equityReturnFn: () => Math.max(-0.55, sampleNormal(mu, sigma)),
    });
    // Pad to full horizon with zeros for aggregation
    const padded = [];
    let infl = 1;
    for (let y = 0; y < horizon; y++) {
      infl *= (1 + inp.inflation / 100);
      padded.push((sim.years[y]?.real) ?? 0);
    }
    trajReal.push(padded);
    yearsLastedArr.push(sim.yearsLasted);
    finalRealArr.push(sim.finalReal);
    if (sim.yearsLasted >= horizon && sim.finalReal >= bequest) successCount++;
  }

  // Compute percentiles at each year
  const percentiles = { p10: [], p25: [], p50: [], p75: [], p90: [] };
  for (let y = 0; y < horizon; y++) {
    const sorted = trajReal.map(t => t[y]).sort((a, b) => a - b);
    percentiles.p10.push(sorted[Math.floor(sorted.length * 0.10)]);
    percentiles.p25.push(sorted[Math.floor(sorted.length * 0.25)]);
    percentiles.p50.push(sorted[Math.floor(sorted.length * 0.50)]);
    percentiles.p75.push(sorted[Math.floor(sorted.length * 0.75)]);
    percentiles.p90.push(sorted[Math.floor(sorted.length * 0.90)]);
  }

  // Histogram of years lasted (bucketed)
  const buckets = new Array(horizon + 1).fill(0);
  yearsLastedArr.forEach(y => { buckets[y]++; });

  // Probability of surviving each year
  const survivalCurve = [];
  for (let y = 1; y <= horizon; y++) {
    const aliveAtY = yearsLastedArr.filter(yl => yl >= y).length;
    survivalCurve.push(aliveAtY / runs);
  }

  // Final real percentiles
  const sortedFinal = [...finalRealArr].sort((a, b) => a - b);
  const finalP10 = sortedFinal[Math.floor(sortedFinal.length * 0.10)];
  const finalP50 = sortedFinal[Math.floor(sortedFinal.length * 0.50)];
  const finalP90 = sortedFinal[Math.floor(sortedFinal.length * 0.90)];

  return {
    runs, successRate: successCount / runs,
    percentiles, survivalCurve, buckets, yearsLastedArr, finalRealArr,
    finalP10, finalP50, finalP90,
  };
}

function makeResult(years, agg, inp) {
  const yearsLasted = years.filter(y => y.total > 0).length;
  const last = years[years.length - 1] || { total: 0, real: 0 };
  const firstDraw = years.find(y => y.fdDraw > 0);
  const firstRebalance = years.find(y => y.rebalanced);
  return {
    years,
    ...agg,
    yearsLasted,
    finalCorpus: last.total,
    finalReal: last.real,
    firstDrawYr: firstDraw ? firstDraw.yr : null,
    firstRebalanceYr: firstRebalance ? firstRebalance.yr : null,
    maxYears: inp.maxYears,
  };
}

/* ════════════════════════════════════════════════════════════════════════
   CHART RENDERERS — pure SVG
   ════════════════════════════════════════════════════════════════════════ */
const tooltipEl = document.getElementById('tooltip');
let CHART_COLORS = [];
function refreshChartColors() {
  const cs = getComputedStyle(document.documentElement);
  CHART_COLORS = [
    cs.getPropertyValue('--chart-1').trim(),
    cs.getPropertyValue('--chart-2').trim(),
    cs.getPropertyValue('--chart-3').trim(),
    cs.getPropertyValue('--chart-4').trim(),
    cs.getPropertyValue('--chart-5').trim(),
    cs.getPropertyValue('--chart-6').trim(),
  ];
}
/** Resolve a color spec — supports var(--foo) or plain color strings. */
function resolveCol(c) {
  if (typeof c !== 'string') return c;
  const m = c.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  if (m) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim();
    return v || c;
  }
  return c;
}

function smoothPath(points) {
  // Catmull-Rom inspired smoothing via cubic Bezier
  if (points.length < 2) return '';
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const t = 0.25;
    const cp1x = p1[0] + (p2[0] - p0[0]) * t;
    const cp1y = p1[1] + (p2[1] - p0[1]) * t;
    const cp2x = p2[0] - (p3[0] - p1[0]) * t;
    const cp2y = p2[1] - (p3[1] - p1[1]) * t;
    d += ` C${cp1x},${cp1y} ${cp2x},${cp2y} ${p2[0]},${p2[1]}`;
  }
  return d;
}

function renderLineChart(container, opts) {
  const { categories, series, height = 320, valueSuffix = '', filled = false, formatTooltip } = opts;
  if (!container || categories.length === 0) return;
  const width = Math.max(320, container.parentElement.clientWidth - 36);
  const padding = { top: 16, right: 16, bottom: 36, left: 60 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const allValues = series.flatMap(s => s.data.filter(Number.isFinite));
  let minY = Math.min(...allValues, 0);
  let maxY = Math.max(...allValues);
  if (minY === maxY) maxY = minY + 1;
  // Add 5% padding to top
  maxY = maxY + (maxY - minY) * 0.06;
  const yRange = maxY - minY;

  const x = i => padding.left + (categories.length > 1 ? (i * innerW / (categories.length - 1)) : innerW / 2);
  const y = v => padding.top + innerH - ((v - minY) / yRange) * innerH;

  // Y axis ticks (5)
  let ticks = '';
  for (let i = 0; i <= 5; i++) {
    const v = minY + (yRange / 5) * i;
    const yy = y(v);
    ticks += `<line class="chart-grid-line" x1="${padding.left}" y1="${yy}" x2="${padding.left + innerW}" y2="${yy}"/>`;
    ticks += `<text class="chart-axis-label" x="${padding.left - 8}" y="${yy + 3}" text-anchor="end">${fmtTick(v, valueSuffix)}</text>`;
  }

  // X axis ticks
  let xLabels = '';
  const xStep = Math.max(1, Math.ceil(categories.length / 10));
  categories.forEach((c, i) => {
    if (i % xStep === 0 || i === categories.length - 1) {
      xLabels += `<text class="chart-axis-label" x="${x(i)}" y="${padding.top + innerH + 18}" text-anchor="middle">${c}</text>`;
    }
  });

  // Series paths + dots
  let paths = '';
  let dots = '';
  series.forEach((s, idx) => {
    const color = resolveCol(s.color || CHART_COLORS[idx % CHART_COLORS.length]);
    const points = s.data.map((v, i) => [x(i), y(v)]);
    const d = smoothPath(points);
    if (filled) {
      const areaD = d + ` L${x(s.data.length - 1)},${padding.top + innerH} L${x(0)},${padding.top + innerH} Z`;
      paths += `<path class="chart-area" d="${areaD}" style="fill:${color}"/>`;
    }
    paths += `<path class="chart-line" style="stroke:${color};animation-delay:${idx * 100}ms" d="${d}"/>`;
    s.data.forEach((v, i) => {
      if (i % xStep === 0 || i === categories.length - 1) {
        dots += `<circle class="chart-dot" cx="${x(i)}" cy="${y(v)}" r="3" style="stroke:${color}"/>`;
      }
    });
  });

  // Hover zones
  let zones = '';
  for (let i = 0; i < categories.length; i++) {
    const left = i === 0 ? padding.left : (x(i - 1) + x(i)) / 2;
    const right = i === categories.length - 1 ? padding.left + innerW : (x(i) + x(i + 1)) / 2;
    zones += `<rect class="chart-hover-zone" x="${left}" y="${padding.top}" width="${right - left}" height="${innerH}" data-i="${i}"/>`;
  }
  // Vertical cursor line
  const cursor = `<line id="cursor-${container.id}" class="chart-cursor" x1="0" y1="${padding.top}" x2="0" y2="${padding.top + innerH}"/>`;

  container.innerHTML = `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      ${ticks}
      ${paths}
      ${dots}
      ${xLabels}
      ${cursor}
      ${zones}
    </svg>
    ${series.length > 1 ? renderLegend(series) : ''}
  `;

  // Hover
  const svgEl = container.querySelector('svg');
  const cursorEl = container.querySelector(`#cursor-${container.id}`);
  svgEl.addEventListener('mousemove', (e) => {
    const target = e.target.closest('.chart-hover-zone');
    if (!target) return;
    const i = +target.dataset.i;
    const xPos = x(i);
    cursorEl.setAttribute('x1', xPos);
    cursorEl.setAttribute('x2', xPos);
    cursorEl.classList.add('show');
    showTooltip(container, e, i, categories, series, formatTooltip, valueSuffix);
  });
  svgEl.addEventListener('mouseleave', () => {
    cursorEl.classList.remove('show');
    hideTooltip();
  });
}

function fmtTick(v, suffix) {
  if (suffix === ' Cr') return v.toFixed(0) + suffix;
  if (suffix === ' L') return v.toFixed(0) + suffix;
  if (suffix === '%') return v.toFixed(0) + suffix;
  if (Math.abs(v) >= 1e7) return (v / 1e7).toFixed(1) + ' Cr';
  if (Math.abs(v) >= 1e5) return (v / 1e5).toFixed(1) + ' L';
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(0) + 'K';
  return v.toFixed(0);
}

function renderBarChart(container, opts) {
  const { categories, series, height = 240, valueSuffix = '', formatTooltip } = opts;
  if (!container || categories.length === 0) return;
  const width = Math.max(280, container.parentElement.clientWidth - 36);
  const padding = { top: 12, right: 12, bottom: 50, left: 56 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const allValues = series.flatMap(s => s.data.filter(Number.isFinite));
  let maxY = Math.max(...allValues);
  let minY = Math.min(0, ...allValues);
  if (maxY === minY) maxY = minY + 1;
  maxY = maxY + (maxY - minY) * 0.1;
  const yRange = maxY - minY;
  const y = v => padding.top + innerH - ((v - minY) / yRange) * innerH;

  const groupW = innerW / categories.length;
  const barGap = 4;
  const barW = Math.max(8, (groupW - 16 - (series.length - 1) * barGap) / series.length);

  let ticks = '';
  for (let i = 0; i <= 5; i++) {
    const v = minY + (yRange / 5) * i;
    const yy = y(v);
    ticks += `<line class="chart-grid-line" x1="${padding.left}" y1="${yy}" x2="${padding.left + innerW}" y2="${yy}"/>`;
    ticks += `<text class="chart-axis-label" x="${padding.left - 6}" y="${yy + 3}" text-anchor="end">${fmtTick(v, valueSuffix)}</text>`;
  }

  let bars = '';
  let hoverZones = '';
  categories.forEach((c, i) => {
    const gx = padding.left + i * groupW + 8;
    series.forEach((s, sIdx) => {
      const color = resolveCol(s.color || CHART_COLORS[sIdx % CHART_COLORS.length]);
      const v = s.data[i] || 0;
      const barH = Math.max(0, Math.abs(y(v) - y(0)));
      const barY = v >= 0 ? y(v) : y(0);
      const bx = gx + sIdx * (barW + barGap);
      bars += `<rect class="chart-bar" style="fill:${color};animation-delay:${(i * series.length + sIdx) * 80}ms" x="${bx}" y="${barY}" width="${barW}" height="${barH}" rx="4"/>`;
    });
    // group label
    const labelLines = c.split('\n');
    labelLines.forEach((line, li) => {
      bars += `<text class="chart-axis-label" x="${gx + (groupW - 16) / 2}" y="${padding.top + innerH + 18 + li * 13}" text-anchor="middle">${line}</text>`;
    });
    // Hover zone
    hoverZones += `<rect class="chart-hover-zone" x="${gx - 8}" y="${padding.top}" width="${groupW}" height="${innerH}" data-i="${i}"/>`;
  });

  container.innerHTML = `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      ${ticks}
      ${bars}
      ${hoverZones}
    </svg>
    ${series.length > 1 ? renderLegend(series) : ''}
  `;

  const svgEl = container.querySelector('svg');
  svgEl.addEventListener('mousemove', (e) => {
    const t = e.target.closest('.chart-hover-zone');
    if (!t) return;
    const i = +t.dataset.i;
    showTooltip(container, e, i, categories, series, formatTooltip, valueSuffix);
  });
  svgEl.addEventListener('mouseleave', () => hideTooltip());
}

function renderLegend(series) {
  return `<div class="chart-legend">${
    series.map((s, idx) => {
      const color = resolveCol(s.color || CHART_COLORS[idx % CHART_COLORS.length]);
      return `<span class="legend-item"><span class="legend-dot" style="background:${color}"></span>${s.name}</span>`;
    }).join('')
  }</div>`;
}

function showTooltip(container, mouseEvent, i, categories, series, formatTooltip, valueSuffix) {
  const rect = container.getBoundingClientRect();
  const left = mouseEvent.clientX - rect.left + container.offsetLeft;
  const top = mouseEvent.clientY - rect.top + container.offsetTop;

  let body = `<div class="tooltip-title">${categories[i]}</div>`;
  series.forEach((s, idx) => {
    const color = resolveCol(s.color || CHART_COLORS[idx % CHART_COLORS.length]);
    const v = s.data[i];
    const formatted = formatTooltip ? formatTooltip(v, s) : (fmtTick(v, valueSuffix));
    body += `<div class="tooltip-row"><span class="legend-dot" style="background:${color}"></span><span>${s.name}</span><span class="tooltip-value">${formatted}</span></div>`;
  });
  tooltipEl.innerHTML = body;
  tooltipEl.style.left = (rect.left + window.scrollX + (mouseEvent.clientX - rect.left)) + 'px';
  tooltipEl.style.top = (rect.top + window.scrollY + (mouseEvent.clientY - rect.top) - 12) + 'px';
  tooltipEl.classList.add('show');
}
function hideTooltip() { tooltipEl.classList.remove('show'); }

/* ════════════════════════════════════════════════════════════════════════
   NUMBER ANIMATION
   ════════════════════════════════════════════════════════════════════════ */
const animRegistry = new Map();
function animateValue(el, to, formatter, duration = 600) {
  if (!el) return;
  const fromRaw = animRegistry.get(el);
  const from = typeof fromRaw === 'number' ? fromRaw : to;
  animRegistry.set(el, to);
  if (from === to) { el.textContent = formatter(to); return; }
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const current = from + (to - from) * eased;
    el.textContent = formatter(current);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
  el.classList.add('pulse');
  setTimeout(() => el.classList.remove('pulse'), 600);
}

function setNum(id, value, formatter) {
  const el = document.getElementById(id);
  if (!el) return;
  if (typeof value === 'number' && isFinite(value)) {
    animateValue(el, value, formatter);
  } else {
    el.textContent = value;
  }
}

/* ════════════════════════════════════════════════════════════════════════
   RENDER FUNCTIONS — orchestrate the whole UI
   ════════════════════════════════════════════════════════════════════════ */
function renderAll() {
  const userSim = simulateUserStrategy();
  const improvedSim = simulateImproved();
  const swpSim = simulateSWP();
  const pureFDSim = simulatePureFD();
  const annuitySim = simulateAnnuity();
  const sims = { user: userSim, improved: improvedSim, swp: swpSim, pureFD: pureFDSim, annuity: annuitySim };

  renderHero(userSim);
  renderInputsFeedback();
  renderInflation();
  renderTrajectory(sims[state.activeStrategy]);
  renderCashflow(userSim);
  renderYearly(userSim);
  renderComparison(sims);
  renderRiskAnalysis(userSim);
  renderWithdrawalChart(userSim);
  renderImprovements(userSim);
  renderAllocation();
  renderPractical();
}

/* ─── Hero & verdict ─── */
function renderHero(sim) {
  const inp = state.inputs;
  setNum('kpiYears', sim.yearsLasted, v =>
    sim.yearsLasted >= sim.maxYears ? `${sim.maxYears}+ Years` : `${Math.round(v)} Years`);
  setNum('kpiFinalReal', sim.finalReal, v => fmtCr(v));

  // "Years money lasts" sub
  document.getElementById('kpiYearsSub').textContent =
    sim.yearsLasted >= sim.maxYears ? `survives full ${sim.maxYears}-year horizon` : `then runs out`;

  // "Depletes at age" — NEW prominent indicator
  const depleteEl = document.getElementById('kpiDepleteAge');
  const depleteSub = document.getElementById('kpiDepleteAgeSub');
  if (depleteEl) {
    depleteEl.classList.remove('success', 'info', 'warning', 'danger');
    if (sim.yearsLasted >= sim.maxYears) {
      animRegistry.delete(depleteEl);  // reset animation state
      depleteEl.textContent = 'Never';
      depleteEl.classList.add('success');
      depleteSub.textContent = `within the ${sim.maxYears}-year horizon`;
    } else {
      const depleteAge = inp.startingAge + sim.yearsLasted;
      setNum('kpiDepleteAge', depleteAge, v => Math.round(v).toString());
      depleteEl.classList.add(sim.yearsLasted < 20 ? 'danger' : 'warning');
      depleteSub.textContent = `year ${sim.yearsLasted + 1} from start of plan · in ${sim.yearsLasted} years`;
    }
  }

  // Final real
  document.getElementById('kpiFinalRealSub').textContent = `after ${pct(inp.inflation)} annual inflation, ${sim.years.length} years`;

  // First FD draw
  document.getElementById('kpiFirstDraw').textContent = sim.firstDrawYr ? `Year ${sim.firstDrawYr}` : 'Never';
  document.getElementById('kpiFirstDrawSub').textContent =
    sim.firstDrawYr ? `expenses exceed net interest` : `interest always covers spending`;

  // Tone for years
  const yearsEl = document.getElementById('kpiYears');
  yearsEl.classList.remove('success', 'warning', 'danger', 'info');
  if (sim.yearsLasted >= sim.maxYears) yearsEl.classList.add('success');
  else if (sim.yearsLasted >= 30) yearsEl.classList.add('info');
  else if (sim.yearsLasted >= 20) yearsEl.classList.add('warning');
  else yearsEl.classList.add('danger');

  // Verdict callout — written in neutral, universal voice
  const verdict = document.getElementById('verdictCallout');
  const bequest = inp.bequestGoal || 0;
  const meetsGoal = sim.finalReal >= bequest;
  const eventsTotal = (inp.events || []).reduce((s, e) => s + (e.amount || 0), 0);
  const eventsLine = eventsTotal > 0 ? ` Includes ${(inp.events||[]).length} life event(s) totaling ${fmtCr(eventsTotal)} (today's ₹).` : '';
  const depleteAge = inp.startingAge + sim.yearsLasted;
  let tone, title, body;
  if (sim.yearsLasted >= sim.maxYears && meetsGoal) {
    tone = 'success'; title = `Plan survives the full ${sim.maxYears}-year horizon · age ${inp.startingAge}→${inp.startingAge + sim.maxYears}`;
    body = `Final corpus <strong>${fmtCr(sim.finalCorpus)} nominal</strong> (<strong>${fmtCr(sim.finalReal)} in today's ₹</strong>).${bequest > 0 ? ` Bequest goal of ${fmtCr(bequest)} <strong>met</strong> with ${fmtCr(sim.finalReal - bequest)} surplus.` : ''} ${sim.rebalances ? `Rebalance triggered ${sim.rebalances} time(s)${sim.firstRebalanceYr ? ` (first at Y${sim.firstRebalanceYr})` : ''}.` : ''}${eventsLine}`;
  } else if (sim.yearsLasted >= sim.maxYears && !meetsGoal) {
    tone = 'warning'; title = `Plan survives — but bequest goal not met`;
    body = `Corpus lasts the full ${sim.maxYears} years, but ${fmtCr(sim.finalReal)} real (today's ₹) falls ${fmtCr(bequest - sim.finalReal)} short of the ${fmtCr(bequest)} legacy goal. Increase corpus, reduce expenses, or accept a smaller bequest.${eventsLine}`;
  } else if (sim.yearsLasted >= 30) {
    tone = 'info'; title = `Plan lasts ${sim.yearsLasted} years · depletes at age ${depleteAge}`;
    body = `Final corpus ${fmtCr(sim.finalCorpus)} (real ${fmtCr(sim.finalReal)}). Healthy margin for a typical retirement; check the Monte Carlo section below to see how it holds up under sequence-of-returns shocks.${eventsLine}`;
  } else if (sim.yearsLasted >= 20) {
    tone = 'warning'; title = `Plan lasts ${sim.yearsLasted} years · depletes at age ${depleteAge} — caution`;
    body = `If life expectancy is past age ${depleteAge}, the plan needs either lower expenses, more equity, or higher returns. Try the "Conservative" preset and check the Risk Analysis section.${eventsLine}`;
  } else {
    tone = 'danger'; title = `Plan only lasts ${sim.yearsLasted} years · corpus hits zero at age ${depleteAge} — at risk`;
    body = `Corpus depletes well before a typical retirement ends. Reduce expenses, raise equity allocation, defer big one-off events, or grow the corpus before drawdown begins.${eventsLine}`;
  }
  verdict.className = 'callout callout-' + tone;
  const icons = { success: '✓', info: 'i', warning: '!', danger: '×' };
  verdict.innerHTML = `<div class="callout-icon">${icons[tone]}</div>
    <div class="callout-body"><div class="callout-title">${title}</div>${body}</div>`;
}

/* ─── Inputs feedback (helper text under sliders) ─── */
function renderInputsFeedback() {
  const inp = state.inputs;
  document.getElementById('totalCorpusHint').textContent = fmtCr(inp.totalCorpus);
  const fdAmt = inp.totalCorpus * inp.fdPercent / 100;
  document.getElementById('fdPercentHint').textContent = `${inp.fdPercent}% · FD ${fmtCr(fdAmt)} · Equity ${fmtCr(inp.totalCorpus - fdAmt)}`;
  const yr10 = inp.monthlyExpense * Math.pow(1 + inp.inflation/100, 9);
  document.getElementById('monthlyExpenseHint').textContent = `Today ${fmtL(inp.monthlyExpense)}/m → Y10 ${fmtL(yr10)}/m`;
  const bequestHint = document.getElementById('bequestHint');
  if (bequestHint) bequestHint.textContent = inp.bequestGoal > 0 ? `Y${inp.maxYears} target ${fmtCr(inp.bequestGoal * Math.pow(1 + inp.inflation/100, inp.maxYears))} nominal` : "today's ₹ (0 = none)";

  // Sync all paired inputs
  const ALL_KEYS = ['totalCorpus', 'fdPercent', 'fdRate', 'equityRate', 'equityVolatility', 'monthlyExpense', 'inflation', 'healthInflation', 'flatTaxRate', 'otherIncome', 'healthInsuranceAnnual', 'pensionAnnual', 'maxYears', 'lifestyleMid', 'lifestyleOld', 'bequestGoal', 'startingAge'];
  ALL_KEYS.forEach(k => {
    const a = document.getElementById(k);
    const b = document.getElementById(k + 'Range');
    if (a && document.activeElement !== a) a.value = inp[k];
    if (b && document.activeElement !== b) b.value = inp[k];
  });
  ['isSenior', 'spouse', 'pensionInflated'].forEach(k => {
    const el = document.getElementById(k);
    if (el) el.checked = inp[k];
  });
  document.getElementById('taxMode-slab').checked = inp.taxMode === 'slab';
  document.getElementById('taxMode-flat').checked = inp.taxMode === 'flat';
  document.getElementById('flatTaxField').style.display = inp.taxMode === 'flat' ? '' : 'none';

  document.getElementById('sampleCorpus').textContent = (inp.totalCorpus / 1e7).toFixed(1).replace(/\.0$/, '');

  // Events total hint
  const evTotal = (inp.events || []).reduce((s, e) => s + (e.amount || 0), 0);
  const evCount = (inp.events || []).length;
  const elHint = document.getElementById('eventsTotalHint');
  if (elHint) elHint.textContent = evCount === 0
    ? 'No life events scheduled.'
    : `${evCount} event${evCount > 1 ? 's' : ''} · total ${fmtCr(evTotal)} in today's ₹`;
}

/* ─── Editable life-events list ─── */
let eventsHighlightTimer = null;

function highlightEventRow(container, idx) {
  if (eventsHighlightTimer) clearTimeout(eventsHighlightTimer);
  container.querySelectorAll('.event-row-moved').forEach((r) => r.classList.remove('event-row-moved'));
  const row = container.querySelector(`.event-row[data-idx="${idx}"]`);
  if (!row) return;
  void row.offsetWidth; // restart animation if moved again quickly
  row.classList.add('event-row-moved');
  eventsHighlightTimer = setTimeout(() => {
    row.classList.remove('event-row-moved');
    eventsHighlightTimer = null;
  }, 1400);
}

function moveEvent(idx, direction) {
  const arr = state.inputs.events;
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= arr.length) return;
  const [moved] = arr.splice(idx, 1);
  arr.splice(newIdx, 0, moved);
  renderEventsList(newIdx);
  saveState();
}

function renderEventsList(highlightIdx) {
  const inp = state.inputs;
  const container = document.getElementById('eventsRows');
  if (!container) return;
  if (!inp.events || inp.events.length === 0) {
    container.innerHTML = `<div class="events-empty">No life events. Click "+ Add event" to schedule a one-off expense — kid's wedding, education, big medical, car, vacation, etc.</div>`;
    return;
  }
  const lastIdx = inp.events.length - 1;
  container.innerHTML = inp.events.map((e, idx) => `
    <div class="event-row" data-idx="${idx}">
      <div class="event-reorder" role="group" aria-label="Reorder event">
        <button type="button" class="event-move event-move-up" aria-label="Move up" title="Move up"${idx === 0 ? ' disabled' : ''}>↑</button>
        <button type="button" class="event-move event-move-down" aria-label="Move down" title="Move down"${idx === lastIdx ? ' disabled' : ''}>↓</button>
      </div>
      <input type="number" class="event-year" min="1" max="${inp.maxYears}" value="${e.year}" title="Year of the event (relative to start)" />
      <input type="number" class="event-amount" min="0" step="50000" value="${e.amount}" title="Amount in today's rupees" />
      <input type="text" class="event-label" placeholder="Description" value="${(e.label || '').replace(/"/g, '&quot;')}" />
      <button type="button" class="event-delete" aria-label="Delete event" title="Delete this event">×</button>
    </div>
  `).join('');

  container.querySelectorAll('.event-row').forEach(row => {
    const idx = +row.dataset.idx;
    row.querySelector('.event-year').addEventListener('input', e => {
      state.inputs.events[idx].year = Math.max(1, parseInt(e.target.value) || 1);
      scheduleUpdate();
      markPresetActive(null);
    });
    row.querySelector('.event-amount').addEventListener('input', e => {
      state.inputs.events[idx].amount = Math.max(0, parseFloat(e.target.value) || 0);
      scheduleUpdate();
      markPresetActive(null);
    });
    row.querySelector('.event-label').addEventListener('input', e => {
      state.inputs.events[idx].label = e.target.value;
      saveState();
    });
    row.querySelector('.event-delete').addEventListener('click', () => {
      state.inputs.events.splice(idx, 1);
      renderEventsList();
      renderAll();
      saveState();
      markPresetActive(null);
    });
    row.querySelector('.event-move-up').addEventListener('click', () => moveEvent(idx, -1));
    row.querySelector('.event-move-down').addEventListener('click', () => moveEvent(idx, 1));
  });

  if (highlightIdx != null) {
    requestAnimationFrame(() => highlightEventRow(container, highlightIdx));
  }
}

/* ─── Inflation panel ─── */
function renderInflation() {
  const inp = state.inputs;
  const milestones = [1, 5, 10, 15, 20, 25, 30, 40, 50].filter(y => y <= inp.maxYears);
  const startFd = inp.totalCorpus * inp.fdPercent / 100;
  const gross = startFd * inp.fdRate / 100;
  const tax = fdTaxOn(gross);
  const netInt = gross - tax;

  // Mini stats
  const milestonesShown = [1, 10, 20, 30].filter(y => y <= inp.maxYears);
  const tones = ['', 'info', 'warning', 'danger'];
  const statsHtml = milestonesShown.map((yr, i) => {
    const factor = Math.pow(1 + inp.inflation/100, yr - 1);
    const monthly = inp.monthlyExpense * factor;
    return `
      <div class="stat-card">
        <span class="stat-label">Year ${yr} monthly need</span>
        <span class="stat-value ${tones[i]}">${fmtL(monthly)}</span>
        <span class="stat-sub">vs Y1: ${factor.toFixed(2)}× more</span>
      </div>`;
  }).join('');
  document.getElementById('inflationStats').innerHTML = statsHtml;

  // Table
  const tbody = document.querySelector('#inflationTable tbody');
  tbody.innerHTML = milestones.map(yr => {
    const factor = Math.pow(1 + inp.inflation/100, yr - 1);
    const monthly = inp.monthlyExpense * factor;
    const annual = monthly * 12;
    const ratio = annual / netInt;
    const toneClass = ratio < 1 ? 'tone-success' : ratio < 2 ? 'tone-warning' : 'tone-danger';
    const ratioText = ratio < 1
      ? `${Math.round(ratio * 100)}% (covered by Y1 interest)`
      : `${Math.round(ratio * 100)}% (${fmtL(annual - netInt)} shortfall)`;
    return `<tr>
      <td>Y${yr}</td>
      <td>${inp.startingAge + yr - 1}</td>
      <td>${fmtL(monthly)}</td>
      <td>${fmtL(annual)}</td>
      <td>${factor.toFixed(2)}×</td>
      <td class="${toneClass}">${ratioText}</td>
    </tr>`;
  }).join('');

  // Chart
  const expenseSeries = milestones.map(yr => +(inp.monthlyExpense * Math.pow(1 + inp.inflation/100, yr - 1) / 1e5).toFixed(2));
  renderLineChart(document.getElementById('inflationChart'), {
    categories: milestones.map(y => `Y${y}`),
    series: [{ name: 'Monthly expense', data: expenseSeries, color: 'var(--warning)' }],
    height: 240,
    valueSuffix: ' L',
    filled: true,
    formatTooltip: (v) => '₹' + v.toFixed(2) + ' L/m',
  });
}

/* ─── Trajectory chart with strategy switching ─── */
function renderTrajectory(sim) {
  const N = sim.years.length;
  const step = N > 30 ? 2 : 1;
  const sampled = sim.years.filter((_, i) => i % step === 0);
  const categories = sampled.map(y => `Y${y.yr}`);
  renderLineChart(document.getElementById('trajectoryChart'), {
    categories,
    series: [
      { name: 'FD value', data: sampled.map(y => +(y.fdEnd / 1e7).toFixed(2)), color: 'var(--chart-1)' },
      { name: 'Equity value', data: sampled.map(y => +(y.eqEnd / 1e7).toFixed(2)), color: 'var(--chart-2)' },
      { name: 'Total (nominal)', data: sampled.map(y => +(y.total / 1e7).toFixed(2)), color: 'var(--chart-3)' },
      { name: "Total (real, today's ₹)", data: sampled.map(y => +(y.real / 1e7).toFixed(2)), color: 'var(--chart-4)' },
    ],
    height: 360, valueSuffix: ' Cr',
    formatTooltip: (v) => '₹' + v.toFixed(2) + ' Cr',
  });
}

/* ─── Cashflow chart ─── */
function renderCashflow(sim) {
  const inp = state.inputs;
  const N = Math.min(30, sim.years.length);
  const slice = sim.years.slice(0, N);
  const hasPension = (inp.pensionAnnual || 0) > 0;
  const hasEvents = (inp.events || []).length > 0;
  const series = [
    { name: 'FD interest (net of tax)', data: slice.map(y => +(y.net / 1e5).toFixed(2)), color: 'var(--info)' },
    { name: 'Routine annual outflow', data: slice.map(y => +((y.totalOutflow - y.eventOut) / 1e5).toFixed(2)), color: 'var(--warning)' },
    { name: 'FD principal drawn', data: slice.map(y => +(y.fdDraw / 1e5).toFixed(2)), color: 'var(--danger)' },
  ];
  if (hasPension) series.push({ name: 'Pension/rental', data: slice.map(y => +((y.pension || 0) / 1e5).toFixed(2)), color: 'var(--chart-6)' });
  if (hasEvents) series.push({ name: 'Life-event outflow', data: slice.map(y => +(y.eventOut / 1e5).toFixed(2)), color: 'var(--chart-5)' });

  renderLineChart(document.getElementById('cashflowChart'), {
    categories: slice.map(y => `Y${y.yr}`),
    series,
    height: 320, valueSuffix: ' L',
    formatTooltip: (v) => '₹' + v.toFixed(2) + ' L',
  });
}

/* ─── Year-by-year table ─── */
function renderYearly(sim) {
  const N = Math.min(40, sim.years.length);
  const rows = sim.years.slice(0, N).map(y => {
    let note = '—';
    if (y.rebalanced) note = `<span class="pill pill-warning">rebalance · LTCG ${fmtL(y.eqTax)}</span>`;
    else if (y.eqTax > 0) note = `<span class="pill pill-info">LTCG ${fmtL(y.eqTax)}</span>`;
    else if (y.surplus > 0) note = `<span class="text-quiet">surplus ${fmtL(y.surplus)}</span>`;
    const cls = y.rebalanced ? 'row-rebalance' : y.fdDraw > 0 ? 'row-drawdown' : '';
    const eventCell = y.eventOut > 0
      ? `<span class="pill pill-danger" title="${(y.eventItems||[]).map(e => `${e.label} (${fmtL(e.amount)})`).join(' · ')}">${fmtL(y.eventOut)}</span>`
      : '—';
    const wrCell = y.withdrawalRate > 0
      ? `<span class="${y.withdrawalRate > 0.06 ? 'pill pill-danger' : y.withdrawalRate > 0.04 ? 'pill pill-warning' : ''}">${(y.withdrawalRate*100).toFixed(1)}%</span>`
      : '—';
    return `<tr class="${cls}">
      <td>${y.yr}</td>
      <td>${y.age}${y.lifestyleMult !== 1 ? ` <span class="text-quiet">×${y.lifestyleMult.toFixed(2)}</span>` : ''}</td>
      <td>${fmtL(y.monthlyExpense)}</td>
      <td>${eventCell}</td>
      <td>${fmtL(y.totalOutflow)}</td>
      <td>${fmtL(y.gross)}</td>
      <td>${fmtL(y.tax)}</td>
      <td>${fmtL(y.net + (y.pension||0))}</td>
      <td>${y.fdDraw > 0 ? fmtL(y.fdDraw) : '—'}</td>
      <td>${fmtCr(y.fdEnd)}</td>
      <td>${fmtCr(y.eqEnd)}</td>
      <td><strong>${fmtCr(y.total)}</strong></td>
      <td>${wrCell}</td>
      <td>${note}</td>
    </tr>`;
  }).join('');
  document.querySelector('#yearlyTable tbody').innerHTML = rows;
}

/* ─── Strategy comparison ─── */
function renderComparison(sims) {
  const inp = state.inputs;
  const STR = [
    { key: 'pureFD', name: 'Pure FD (no equity)', desc: 'Everything stays in fixed deposit. No market risk, but inflation slowly eats real purchasing power.' },
    { key: 'user', name: '50/50 FD + Equity', desc: 'Half in fixed deposit, half in equity. Spend FD interest first; once the FD bucket empties, sell half the equity to refill it. Simple, reactive — easy to execute.' },
    { key: 'improved', name: 'SCSS-led (annual rebalance)', desc: `${inp.spouse ? '₹60 L (₹30 L × 2 spouses)' : '₹30 L'} in Senior Citizen Savings Scheme at 8.2%, rest in FD/equity. Top up from equity once a year using the ₹1.25 L LTCG exemption. Higher yield, lower tax — for 60+.` },
    { key: 'swp', name: 'Arbitrage + SWP', desc: 'Park "safe" bucket in arbitrage mutual funds (taxed as equity, ~12.5% LTCG instead of slab). Withdraw monthly via Systematic Withdrawal Plan. Most tax-efficient option.' },
    { key: 'annuity', name: 'Lifetime annuity', desc: `Hand the whole amount to an insurance company. They pay you a fixed monthly income for life @ ~${annuityRateFor(inp.startingAge).toFixed(1)}% (with money returned to heirs at death). No market risk, but fixed payout loses to inflation over decades.` },
  ];

  // Strategy cards
  document.getElementById('strategyCards').innerHTML = STR.map(s => {
    const sim = sims[s.key];
    const yearsTxt = sim.yearsLasted >= sim.maxYears ? `${sim.maxYears}+ yrs` : `${sim.yearsLasted} yrs`;
    const pillTone = sim.yearsLasted >= sim.maxYears ? 'success' : sim.yearsLasted >= 30 ? 'info' : 'warning';
    return `<div class="card">
      <div class="card-header">
        <span class="card-title">${s.name}</span>
        <span class="pill pill-${pillTone}">${yearsTxt}</span>
      </div>
      <p class="card-body">${s.desc}</p>
      <div class="divider" style="margin: 12px 0"></div>
      <div class="text-sm" style="display:flex; flex-direction:column; gap:6px">
        <div style="display:flex; justify-content:space-between"><span class="text-muted">Final (nominal)</span><strong>${fmtCr(sim.finalCorpus)}</strong></div>
        <div style="display:flex; justify-content:space-between"><span class="text-muted">Final (real)</span><strong>${fmtCr(sim.finalReal)}</strong></div>
        <div style="display:flex; justify-content:space-between"><span class="text-muted">Total tax</span><strong>${fmtCr(sim.totalFDTax + sim.totalEqTax)}</strong></div>
      </div>
    </div>`;
  }).join('');

  // Bar charts
  const cats = STR.map(s => s.name.split(' (')[0]);
  renderBarChart(document.getElementById('compareYearsChart'), {
    categories: cats,
    series: [{ name: 'Years lasted', data: STR.map(s => sims[s.key].yearsLasted >= sims[s.key].maxYears ? sims[s.key].maxYears : sims[s.key].yearsLasted), color: 'var(--chart-1)' }],
    height: 220, valueSuffix: ' yrs',
    formatTooltip: (v) => `${Math.round(v)} years`,
  });
  renderBarChart(document.getElementById('compareCorpusChart'), {
    categories: cats,
    series: [{ name: 'Real corpus (₹ Cr)', data: STR.map(s => +(sims[s.key].finalReal / 1e7).toFixed(2)), color: 'var(--chart-2)' }],
    height: 220, valueSuffix: ' Cr',
    formatTooltip: (v) => fmtCr(v * 1e7),
  });

  // Table
  document.querySelector('#compareTable tbody').innerHTML = STR.map(s => {
    const sim = sims[s.key];
    return `<tr>
      <td>${s.name}</td>
      <td>${sim.yearsLasted >= sim.maxYears ? sim.maxYears + '+' : sim.yearsLasted}</td>
      <td>${fmtCr(sim.finalCorpus)}</td>
      <td>${fmtCr(sim.finalReal)}</td>
      <td>${fmtCr(sim.totalFDTax + sim.totalEqTax)}</td>
      <td>${sim.rebalances}</td>
    </tr>`;
  }).join('');
}

/* ─── Risk analysis (Monte Carlo) ─── */
let _mcCache = null;
let _mcCacheKey = '';
function renderRiskAnalysis(deterministicSim) {
  const inp = state.inputs;
  const key = JSON.stringify({...inp, events: inp.events?.length || 0});
  let mc;
  if (_mcCacheKey === key && _mcCache) mc = _mcCache;
  else {
    mc = runMonteCarlo(inp, inp.mcRuns || 500);
    _mcCache = mc; _mcCacheKey = key;
  }

  document.getElementById('mcRunsLabel').textContent = mc.runs;

  // Stats
  const successPct = (mc.successRate * 100).toFixed(0) + '%';
  const tone = mc.successRate >= 0.95 ? 'success' : mc.successRate >= 0.80 ? 'info' : mc.successRate >= 0.60 ? 'warning' : 'danger';
  const medianYears = [...mc.yearsLastedArr].sort((a,b)=>a-b)[Math.floor(mc.yearsLastedArr.length/2)];
  const worstYears = Math.min(...mc.yearsLastedArr);
  document.getElementById('mcStats').innerHTML = `
    <div class="stat-card">
      <span class="stat-label">Probability of success</span>
      <span class="stat-value ${tone}">${successPct}</span>
      <span class="stat-sub">corpus &gt; ${inp.bequestGoal > 0 ? 'bequest goal' : '0'} at Y${inp.maxYears}</span>
    </div>
    <div class="stat-card">
      <span class="stat-label">Median outcome</span>
      <span class="stat-value">${fmtCr(mc.finalP50)}</span>
      <span class="stat-sub">real, today's ₹</span>
    </div>
    <div class="stat-card">
      <span class="stat-label">P10 (bad case)</span>
      <span class="stat-value ${mc.finalP10 > 0 ? '' : 'danger'}">${fmtCr(mc.finalP10)}</span>
      <span class="stat-sub">10% of runs end below this</span>
    </div>
    <div class="stat-card">
      <span class="stat-label">Worst run lasted</span>
      <span class="stat-value ${worstYears < 20 ? 'danger' : worstYears < 30 ? 'warning' : ''}">${worstYears} yrs</span>
      <span class="stat-sub">vs ${inp.maxYears}-yr horizon</span>
    </div>
  `;

  // Survival curve
  const years = mc.survivalCurve.length;
  const cats = [];
  const step = years > 30 ? 2 : 1;
  for (let y = 1; y <= years; y += step) cats.push('Y' + y);
  renderLineChart(document.getElementById('mcSurvivalChart'), {
    categories: cats,
    series: [{
      name: 'P(corpus > 0)',
      data: cats.map((_, i) => +(mc.survivalCurve[Math.min(mc.survivalCurve.length-1, i * step)] * 100).toFixed(1)),
      color: 'var(--info)',
    }],
    height: 280,
    valueSuffix: '%',
    filled: true,
    formatTooltip: v => v.toFixed(1) + '% of runs',
  });

  // Bands chart: P10, P50, P90 of real corpus
  renderLineChart(document.getElementById('mcBandsChart'), {
    categories: cats,
    series: [
      { name: 'P90 (best 10%)', data: cats.map((_, i) => +(mc.percentiles.p90[Math.min(years-1, i * step)] / 1e7).toFixed(2)), color: 'var(--chart-2)' },
      { name: 'Median (P50)',    data: cats.map((_, i) => +(mc.percentiles.p50[Math.min(years-1, i * step)] / 1e7).toFixed(2)), color: 'var(--chart-1)' },
      { name: 'P10 (worst 10%)', data: cats.map((_, i) => +(mc.percentiles.p10[Math.min(years-1, i * step)] / 1e7).toFixed(2)), color: 'var(--chart-4)' },
    ],
    height: 280,
    valueSuffix: ' Cr',
    formatTooltip: v => '₹' + v.toFixed(2) + ' Cr',
  });

  // Distribution chart — bucket final real corpus
  const finals = mc.finalRealArr;
  const maxFinal = Math.max(...finals);
  const nBuckets = 16;
  const bucketSize = (maxFinal > 0 ? maxFinal : 1e7) / nBuckets;
  const counts = new Array(nBuckets).fill(0);
  finals.forEach(v => {
    const b = Math.min(nBuckets - 1, Math.max(0, Math.floor(v / bucketSize)));
    counts[b]++;
  });
  const distCats = counts.map((_, i) => {
    const lo = i * bucketSize / 1e7;
    const hi = (i + 1) * bucketSize / 1e7;
    return (i === 0 && lo === 0) ? '0' : `${lo.toFixed(1)}-${hi.toFixed(1)}`;
  });
  renderBarChart(document.getElementById('mcDistChart'), {
    categories: distCats,
    series: [{ name: 'Final real corpus (Cr)', data: counts, color: 'var(--chart-6)' }],
    height: 240,
    valueSuffix: '',
    formatTooltip: v => Math.round(v) + ' runs',
  });

  // Interpretation callout
  const interp = document.getElementById('mcInterpretation');
  let title, body;
  if (mc.successRate >= 0.95) {
    title = `Very robust — ${successPct} of simulations succeed`;
    body = `Your plan survives even when equity returns are sampled randomly from N(${inp.equityRate}%, ${inp.equityVolatility}%). Worst run still lasted ${worstYears} years. You have a comfortable margin against sequence-of-returns risk.`;
  } else if (mc.successRate >= 0.80) {
    title = `Reasonable — ${successPct} probability of success`;
    body = `Above 80% is acceptable for most retirees. ${(100 - mc.successRate*100).toFixed(0)}% of runs depleted early — these are the "bad sequence" outcomes (crash in first few years). Mitigation: bigger fixed-income floor, lower expenses, or part annuity.`;
  } else if (mc.successRate >= 0.60) {
    title = `Caution — only ${successPct} of runs succeed`;
    body = `You have ~${(100 - mc.successRate*100).toFixed(0)}% chance of running out of money. Consider: (1) increasing fixed-income allocation to absorb early shocks, (2) reducing expense baseline, (3) part-annuitisation to lock in a floor, or (4) a lower target real bequest.`;
  } else {
    title = `High risk — ${successPct} of runs deplete`;
    body = `Less than 60% probability of success is dangerous. Your plan depends on equity returns going right. Either delay drawdown, reduce expenses materially, or shift toward annuity + bond floor with smaller equity tail.`;
  }
  interp.className = 'callout callout-' + tone;
  const icons = { success: '✓', info: 'i', warning: '!', danger: '×' };
  interp.innerHTML = `<div class="callout-icon">${icons[tone]}</div>
    <div class="callout-body"><div class="callout-title">${title}</div>${body}</div>`;
}

/* ─── Withdrawal rate chart ─── */
function renderWithdrawalChart(sim) {
  const slice = sim.years.slice(0, Math.min(40, sim.years.length));
  const wrPct = slice.map(y => +(y.withdrawalRate * 100).toFixed(2));
  const safeLine = slice.map(() => 4);  // 4% rule of thumb
  renderLineChart(document.getElementById('withdrawalChart'), {
    categories: slice.map(y => `Y${y.yr}`),
    series: [
      { name: 'Annual withdrawal rate', data: wrPct, color: 'var(--chart-1)' },
      { name: 'Safe rate (4%)', data: safeLine, color: 'var(--warning)' },
    ],
    height: 280,
    valueSuffix: '%',
    formatTooltip: v => v.toFixed(2) + '%',
  });
}

/* ─── Improvements list ─── */
function renderImprovements(sim) {
  const inp = state.inputs;
  const y1 = sim.years[0];
  const y1Gross = y1 ? y1.gross : (inp.totalCorpus * inp.fdPercent / 100 * inp.fdRate / 100);
  const otherInc = inp.otherIncome || 0;
  const y1SlabTax = computeSlabTax(y1Gross + otherInc, inp.isSenior) - computeSlabTax(otherInc, inp.isSenior);
  const y1FlatTax = y1Gross * 0.30;
  const taxSavings = Math.max(0, y1FlatTax - y1SlabTax);
  // Spouse tax-split savings (vs solo filer)
  const halfTax = Math.max(0, computeSlabTax(y1Gross/2 + otherInc/2, inp.isSenior) - computeSlabTax(otherInc/2, inp.isSenior)) * 2;
  const spouseSavings = Math.max(0, y1SlabTax - halfTax);

  const items = [
    {
      title: '1. Fix the tax assumption', tone: 'success',
      impact: `~${fmtL(taxSavings)}/yr`,
      body: `30% is the <em>marginal</em> rate, not the effective one. Under the FY 2025-26 New Regime, on ${fmtL(y1Gross)} of FD interest with no other income your effective tax is closer to <strong>${pct((y1SlabTax/Math.max(1,y1Gross))*100)}</strong> (87A rebate up to ₹12 L). Switch <span class="mono">Tax mode</span> above to <span class="mono">Slab</span> to see live impact.`,
    },
    {
      title: `2. Use ${inp.spouse ? 'both spouses\' SCSS slots (₹60 L)' : 'SCSS (₹30 L)'}`, tone: 'success',
      impact: inp.spouse ? '+1.7% on ₹60 L = ₹1.02 L/yr' : '+1.7% on ₹30 L = ₹51K/yr',
      body: `Senior Citizen Savings Scheme (60+) pays <strong>8.2% p.a.</strong> sovereign-backed, quarterly payout. Max ₹30 L/individual, ${inp.spouse ? `<strong>₹60 L for your couple</strong> (already modelled).` : '₹60 L for a couple — toggle <span class="mono">Spouse on board</span> above to unlock.'} TDS threshold raised to ₹1 L/bank from FY 25-26.`,
    },
    {
      title: '3. Add RBI Floating Rate Savings Bonds', tone: 'success',
      impact: '+1.55% vs FD',
      body: `RBI FRSB 2020 (Taxable) — <strong>8.05% for Jan-Jun 2026</strong>, sovereign, 7-yr lock-in, semi-annual payout. No per-individual cap. Park ₹50 L–1 Cr for rate uplift over FD.`,
    },
    {
      title: '4. Replace FD with arbitrage-fund SWP', tone: 'info',
      impact: '12.5% LTCG vs slab',
      body: `Arbitrage funds keep ≥65% in equity → taxed <strong>as equity</strong> (12.5% LTCG, ₹1.25 L exemption). Returns ~6-7% with FD-like stability. An SWP draws only the gain portion as taxable — early years can be near-zero tax.`,
    },
    {
      title: '5. Rebalance annually, not at FD = 0', tone: 'warning',
      impact: 'Cuts sequence-of-returns risk',
      body: `The 50/50 strategy waits until FD empties before rebalancing — that's one massive equity sale at one moment. If equity is crashing that day, you sell low. Better: maintain a 3–5 year expense floor in FD/SCSS and top up from equity each year only when equity is up. See the Monte Carlo section below for what the difference is worth.`,
    },
    {
      title: '6. Harvest ₹1.25 L LTCG exemption yearly', tone: 'info',
      impact: `${fmtL(125000 * 0.125)}/yr saved`,
      body: `₹1.25 L of equity LTCG per year is tax-free. Even if you don't need the money, redeem to crystallise ~₹1.25 L of gain and reinvest the next day. You've stepped up your cost basis at zero tax cost.`,
    },
    {
      title: '7. Split income between spouses', tone: 'success',
      impact: inp.spouse ? `~${fmtL(spouseSavings)}/yr saved` : 'Each gets own ₹12 L 87A rebate',
      body: `Two filers means two ₹12 L rebate thresholds, two ₹50 K 80TTB, two ₹1 L TDS thresholds. Realistic if each spouse holds their own SCSS account and FDs from their pre-retirement savings (no clubbing). ${inp.spouse ? 'Already modelled above ✓' : 'Toggle <span class="mono">Spouse on board</span> to model.'}`,
    },
    {
      title: '8. Defer big life events when possible', tone: 'info',
      impact: `₹1 = ₹${(Math.pow(1 + inp.equityRate/100, 5) / Math.pow(1 + inp.inflation/100, 5)).toFixed(2)} in 5 yrs (real)`,
      body: `Each rupee NOT spent today compounds at your equity rate minus inflation. A ₹20 L wedding postponed 5 years (or scaled down by ₹5 L) frees up significant equity compounding. Especially valuable in the early "sequence-of-returns" window.`,
    },
  ];

  document.getElementById('improvementsList').innerHTML = items.map(it => `
    <div class="card">
      <div class="card-header">
        <span class="card-title">${it.title}</span>
        <span class="pill pill-${it.tone}">${it.impact}</span>
      </div>
      <p class="card-body">${it.body}</p>
    </div>
  `).join('');
}

function renderAllocation() {
  const inp = state.inputs;
  const C = inp.totalCorpus;
  const rows = [
    { bucket: 'Buffer · 0–2 yr expenses',  inst: 'Liquid funds / sweep-in FD',         amount: Math.min(2 * inp.monthlyExpense * 12, C * 0.04), ret: '5–6%',       tax: 'Slab on gains' },
    { bucket: 'Income · 3–7 yr',           inst: 'SCSS (₹30 L/spouse, max ₹60 L)',     amount: Math.min(6000000, C * 0.10),                     ret: '8.2%',       tax: 'Slab' },
    { bucket: 'Income · 3–7 yr',           inst: 'RBI FRSB 2020',                       amount: Math.min(5000000, C * 0.08),                     ret: '8.05% float', tax: 'Slab' },
    { bucket: 'Income · 3–7 yr',           inst: 'Bank FD (laddered, 4–6 banks)',       amount: Math.min(8000000, C * 0.13),                     ret: '6.5–7.2%',   tax: 'Slab' },
    { bucket: 'Stability · 5–10 yr',       inst: 'Arbitrage / conservative hybrid SWP', amount: Math.min(6600000, C * 0.11),                     ret: '6–8%',       tax: 'Equity (12.5% LTCG)' },
    { bucket: 'Growth · 10+ yr',           inst: 'Equity index / flexi-cap',            amount: C - 2400000 - 6000000 - 5000000 - 8000000 - 6600000, ret: '10–12%',    tax: 'Equity (12.5% LTCG)' },
  ];
  // Recompute growth as residual; if total corpus is too small, scale proportionally
  const fixedTotal = rows.slice(0,5).reduce((a,r) => a+r.amount, 0);
  rows[5].amount = Math.max(0, C - fixedTotal);
  const total = rows.reduce((a,r) => a+r.amount, 0) || 1;
  document.querySelector('#allocationTable tbody').innerHTML = rows.map(r => `
    <tr>
      <td>${r.bucket}</td>
      <td>${r.inst}</td>
      <td>${fmtCr(r.amount)}</td>
      <td>${r.ret}</td>
      <td>${r.tax}</td>
      <td>${(r.amount/total*100).toFixed(0)}%</td>
    </tr>
  `).join('');
}

function renderPractical() {
  const items = [
    { title: 'Health insurance is non-negotiable', body: 'At 60+ a hospitalisation in Delhi NCR can run ₹10–30 L. Carry a family floater ₹50 L–1 Cr plus a super top-up (deductible ~₹10 L). Premium ₹40–80K/yr for a 60-yr-old, rising fast with age. The Annual health insurance input above is already in the model.' },
    { title: 'Separate emergency fund', body: '6–12 months expenses (₹6–12 L) in pure liquid form, outside the bucket. This stops you from selling equity at lows for a sudden bill (roof, car, family medical). Even more important if you have low pension/rental.' },
    { title: 'Tax rules will change', body: 'Today: New Regime, ₹12 L rebate, LTCG 12.5%, ₹1.25 L exemption. Five years out all of these may have moved. Build tax diversification (slab-taxed FD + equity-taxed arbitrage/equity + sovereign SCSS) so one regime change doesn\'t break the plan.' },
    { title: 'FD safety has a ₹5 L cap (DICGC)', body: 'DICGC insures bank deposits up to ₹5 L per bank per depositor. Spread across 4–6 strong banks (SBI, HDFC, ICICI, Axis, Kotak). Avoid putting more than ₹50 L in a small finance bank no matter how attractive the rate.' },
    { title: 'Estate / nomination paperwork', body: 'Add nominees on every FD, SCSS, demat, MF folio. Write a simple registered Will. For a ₹6 Cr+ corpus the cost of <em>not</em> doing this is years of probate for your family.' },
    { title: 'Behavioural lifestyle creep', body: 'Your "₹1 L/month" today is a budget, not a forecast. Helping children with a deposit, frequent travel, switching to a premium society — these compound. Try the "Fat expenses" preset to see your real cushion.' },
    { title: 'Cognitive decline at 75+', body: 'By age 75–80 financial decision-making weakens. Pre-commit: simple instructions for your spouse/child, an executor for the broker accounts, one trusted CA for taxes, joint holdings on bank accounts. Don\'t leave a 10-bucket plan that no one but you understands.' },
    { title: 'Real estate is not in this model', body: 'Most Indian retirees also own their primary home (often ₹2–4 Cr). It is illiquid but provides housing security. Some have a rental property (model that as Pension/rental income). Reverse mortgage is technically available but rarely used; treat real estate as a fallback, not a draw-down asset.' },
  ];
  document.getElementById('practicalList').innerHTML = items.map(it => `
    <div class="card">
      <div class="card-header"><span class="card-title">${it.title}</span></div>
      <p class="card-body">${it.body}</p>
    </div>
  `).join('');
}

/* ════════════════════════════════════════════════════════════════════════
   STATE PERSISTENCE
   ════════════════════════════════════════════════════════════════════════ */
function saveState() {
  try { localStorage.setItem('retire-calc-v1', JSON.stringify(state.inputs)); } catch (e) {}
}
function loadSavedState() {
  try {
    const raw = localStorage.getItem('retire-calc-v1');
    if (!raw) return null;
    const saved = JSON.parse(raw);
    return { ...DEFAULTS, ...saved };
  } catch (e) { return null; }
}

/* ════════════════════════════════════════════════════════════════════════
   INFO POPOVERS — explain every piece of jargon on click/hover
   ════════════════════════════════════════════════════════════════════════ */
const INFO_CONTENT = {
  'wd-rate': {
    title: 'Withdrawal Rate (WD rate)',
    body: `<strong>WD rate</strong> = amount drawn this year ÷ corpus at start of year. It tells you how hard your nest egg is working.
      <br><br>The classic <strong>4% safe withdrawal rate</strong> comes from William Bengen's 1994 study — withdrawing 4% of starting corpus each year (inflation-adjusted) lasts at least 30 years across all historical US market periods.
      <br><br>For India with structurally higher inflation, <strong>3.5% is a more realistic safe rate</strong>. Above 5–6% sustained means the plan is fragile.`,
  },
  'years-lasted': {
    title: 'Years money lasts',
    body: `How many years before the total corpus (FD + equity) hits zero under your current inputs and the selected strategy.
      <br><br>"50+" means the corpus survives the full simulated horizon — the simulation stopped because the timeline ran out, not because the money did.`,
  },
  'deplete-age': {
    title: 'Depletes at age',
    body: `The exact age at which the corpus is expected to hit zero, given your inputs.
      <br><br>"Never" means the plan survives the entire simulated horizon (default 50 years). Anything over <strong>your expected life span</strong> is the only acceptable answer here.`,
  },
  'real-nominal': {
    title: 'Real vs nominal corpus',
    body: `<strong>Nominal</strong> = the rupee number you'd see on a future bank statement.<br>
      <strong>Real</strong> = the same money expressed in <em>today's purchasing power</em>, after inflation.
      <br><br>At 6% inflation, <strong>₹10 Cr in 30 years has the purchasing power of only ₹1.74 Cr today</strong>. Always look at the real number to know how rich you actually are.`,
  },
  'first-draw': {
    title: 'First time FD principal is touched',
    body: `Initially, the net interest from the FD bucket covers your monthly expenses. As expenses grow with inflation, eventually they overtake interest — and you have to start drawing down the FD <em>principal</em>, not just the interest.
      <br><br>This year is the inflection point. After this, the corpus starts shrinking in real terms.`,
  },
  'inputs-overview': {
    title: 'How to use the inputs',
    body: `Every field is editable — type a number, drag the slider, or click a preset.
      <br><br><strong>Defaults illustrate a ₹6 Cr lumpsum at age 30 with ₹1 L/month expenses</strong>, 50/50 FD-equity allocation, FY 2025-26 slab tax. Change anything to match your situation.
      <br><br>Your inputs are saved in <code>localStorage</code> on your device, so values persist between visits.`,
  },
  'strategy-user': {
    title: '50/50 FD + Equity (classic split)',
    body: `<strong>The classic balanced retirement strategy.</strong> Put half your money in a fixed deposit, half in equity (Nifty/Sensex index funds, large-cap mutual funds, etc.).
      <br><br><strong>How it works:</strong> Spend the FD's monthly interest for daily expenses. When inflation eats into that buffer and you start needing more, draw from the FD principal. When the FD runs out completely, sell half of your accumulated equity and put it back into FD. Repeat.
      <br><br><strong>Best for:</strong> people who want a simple rule that's easy to execute and doesn't require constant tweaking. The trade-off is tax inefficiency and a single "big sell" moment that's risky if markets crash that year.`,
  },
  'strategy-improved': {
    title: 'SCSS-led with annual rebalance (for 60+)',
    body: `Designed for <strong>senior citizens (60+)</strong>. The first ₹30 L (or ₹60 L if both spouses are eligible) goes into <strong>Senior Citizen Savings Scheme at 8.2%</strong> — Government-backed, quarterly payout, better than any bank FD.
      <br><br>The rest is split between FD and equity. Once a year (not when FD runs dry), you sell up to ₹1.25 L of equity gains tax-free (LTCG exemption) and top up the safe bucket.
      <br><br><strong>Why it's smarter:</strong> Higher base yield (8.2% vs 6.5% FD), tax-free annual harvesting, and you're never forced to sell equity in a bad year.`,
  },
  'strategy-swp': {
    title: 'Arbitrage funds + Systematic Withdrawal Plan',
    body: `Instead of FD, park your safe bucket in <strong>arbitrage mutual funds</strong>. These behave like FD (low risk, ~6–7% returns) but are taxed as equity — meaning Long-Term Capital Gains of 12.5% above ₹1.25 L, instead of slab rate (up to 30%) on FD interest.
      <br><br>Then set up a <strong>Systematic Withdrawal Plan</strong> — sell a fixed rupee amount of units every month for income. Only the gains portion of each redemption is taxed.
      <br><br><strong>Best for:</strong> people in the 30% tax bracket with large amounts (₹2 Cr+). The tax saving compounds enormously over 20+ years. Slightly more complex to set up.`,
  },
  'strategy-pureFD': {
    title: 'Pure Fixed Deposit (no equity at all)',
    body: `Park everything in a bank or post-office FD at around 6.5–7.5%. Zero stock market risk.
      <br><br><strong>What goes wrong:</strong> over 20+ years, inflation quietly destroys real purchasing power. A ₹1 Cr corpus earning ₹6.5 L/year looks fine today — but in 20 years that same ₹6.5 L only buys what ₹2 L buys today.
      <br><br>Useful as a worst-case baseline. <strong>Almost nobody should actually run Pure FD for full retirement</strong> — but seeing how it fails shows why some equity exposure is essential.`,
  },
  'strategy-annuity': {
    title: 'Lifetime annuity (insurance product)',
    body: `Hand your entire lumpsum to an insurance company (e.g., LIC Jeevan Akshay-VII, HDFC Life, ICICI Prudential). They pay you a <strong>fixed monthly income for as long as you live</strong> — guaranteed, no market risk.
      <br><br><strong>Pros:</strong> can never run out, no rebalancing, no decisions, peace of mind.
      <br><br><strong>Cons:</strong> the payout is <strong>fixed forever</strong> — no inflation adjustment, so the rupees buy less and less each year. Money is locked up (no early redemption). At death, money usually goes back to the insurer unless you choose "return of purchase price" (which reduces payout to ~5.5%).
      <br><br><strong>Annuity rate by age:</strong> ~6.0% at age 60, ~7.0% at 70, ~7.5% at 80. Older = higher rate.`,
  },
  'events': {
    title: 'One-off life events',
    body: `Big future expenses you want the model to plan for — child's wedding, MBA abroad, big medical, car replacement, international travel, hospitalisation reserve, etc.
      <br><br>Enter the amount in <strong>today's rupees</strong>; the calculator inflates it to future rupees automatically.
      <br><br>In the event year, the calculator subtracts the amount from your corpus — drawn first from FD, then from equity (with LTCG tax computed on the equity portion).
      <br><br><strong>Use the ↑ ↓ buttons to reorder rows</strong> — the order is just for your visual organisation; the actual scheduling comes from the "year" field.`,
  },

  /* ── Per-input help, prefixed "field-" ───────────────────────────────── */
  'field-totalCorpus': {
    title: 'Total corpus',
    body: `The total amount you have today (or expect to have at retirement) — sum of bank balances, FDs, mutual funds, stocks, EPF, PPF, NPS, plus any real-estate sale proceeds you intend to invest.
      <br><br>This is the <strong>starting fuel</strong> for the entire retirement plan. Everything below is calculated against this number.
      <br><br><strong>Default ₹6 Cr</strong> ≈ what a Tier-1 city couple needs for ~25 years at ₹1 L/month base expenses. Adjust to your actual lumpsum.`,
  },
  'field-fdPercent': {
    title: 'FD allocation',
    body: `Percentage of your corpus parked in <strong>safe instruments</strong> (bank FD, post-office, debt funds, SCSS). The remainder goes to <strong>equity</strong> (Nifty 50 / Sensex index funds, large-cap mutual funds).
      <br><br>Higher FD = lower volatility but lower long-term return → corpus may not last against inflation.<br>
      Lower FD = higher returns but bigger swings (and more sequence-of-returns risk early in retirement).
      <br><br><strong>Rule of thumb:</strong> "100 minus your age = % in equity". So at 60, ~40% equity / 60% FD. At 30 (saving phase), 70% equity / 30% FD.`,
  },
  'field-maxYears': {
    title: 'Simulation horizon',
    body: `How many years to project the plan into the future.
      <br><br><strong>Default 50</strong> covers most realistic retirement spans (e.g., retire at 60, plan to age 110 — well past Indian life expectancy of ~70).
      <br><br>Increase if you're FIRE-retiring at 35 and want to test 70+ years; decrease for a conservative shorter check.
      <br><br>The "Years money lasts" stat is capped at this horizon — "50+" means the corpus survived the full window.`,
  },
  'field-fdRate': {
    title: 'FD interest rate',
    body: `Annual interest your <strong>safe bucket</strong> earns. Use a representative bank or post-office FD rate.
      <br><br><strong>May 2026 reference:</strong> SBI 5y FD ~6.5% · HDFC ~7.0% · post-office 5y ~7.5% · <strong>SCSS 8.2%</strong> (60+ only).
      <br><br>This rate is taxed under your selected Tax mode (slab or flat). For an even more conservative plan, plug in a post-tax rate manually.`,
  },
  'field-equityRate': {
    title: 'Equity return',
    body: `The <strong>expected long-term annual return</strong> from your equity bucket — Nifty 50 / Sensex index funds, large-cap mutual funds.
      <br><br><strong>Reality check:</strong> Nifty 20-year CAGR is ~11–12%. Don't pencil in 15%+ — that's optimistic and will mislead the plan.
      <br><br><strong>Sensible values:</strong> 10–12% base case · 8% conservative · 13% optimistic.
      <br><br>This number is also the <em>centre</em> of the bell curve used by Monte Carlo to draw random yearly returns.
      <br><br><span class="text-quiet">Finance textbooks call this the <em>mean</em> and write it as <strong>μ</strong> (Greek "mu") — same thing.</span>`,
  },
  'field-equityVolatility': {
    title: 'Equity volatility',
    body: `<strong>How much your equity returns swing</strong> from year to year — the typical wobble around the expected return.
      <br><br><strong>Nifty 50 historical:</strong> 18–22% per year. So a 12% expected return with 18% volatility means actual yearly returns commonly land between <strong>−6% and +30%</strong>.
      <br><br>This feeds the <strong>Monte Carlo simulation</strong> — higher volatility = more "bad sequence" outcomes where the plan fails despite a high average return.
      <br><br>Set to <strong>0</strong> for a no-risk deterministic projection (every year hits the expected return exactly).
      <br><br><span class="text-quiet">Finance textbooks call this the <em>standard deviation</em> and write it as <strong>σ</strong> (Greek "sigma") — same thing.</span>`,
  },
  'field-inflation': {
    title: 'General inflation (CPI)',
    body: `Annual rate at which your <strong>monthly living expenses grow</strong>. Indian CPI is structurally higher than developed-country CPI.
      <br><br><strong>RBI target band:</strong> 2–6%. <strong>Recent FY:</strong> 4.6–5.0%. <strong>Long-term India CPI average:</strong> ~6%.
      <br><br><strong>Default 6%</strong> gives a safer plan. Use 5% for an optimistic case, 7% if you're worried about food/energy shocks. This <em>does not</em> apply to healthcare — that has its own field below.`,
  },
  'field-healthInflation': {
    title: 'Healthcare inflation',
    body: `Annual rate at which <strong>medical costs rise</strong> — and they rise much faster than general CPI in India.
      <br><br><strong>India healthcare inflation</strong> has run at 12–14% for 15+ years across hospital bills, surgery, ICU and insurance premiums. This is one of the biggest threats to retirement plans.
      <br><br><strong>Applied to:</strong> health insurance premium growth and any medical-related life events.<br>
      <strong>Don't be tempted</strong> to set this equal to CPI — that's the most common mistake in DIY plans.`,
  },
  'field-monthlyExpense': {
    title: 'Monthly living expense',
    body: `Your average current monthly spend on living costs — rent/EMI, groceries, utilities, transport, household help, dining out, kids, subscriptions. <strong>In today's rupees.</strong>
      <br><br><strong>Tip:</strong> pull last 6 months of bank/credit-card statements and average. Add a 10% buffer for irregulars (gifts, repairs).
      <br><br>The calculator inflates this every year by the General inflation rate, and adjusts it by the lifestyle multipliers in older age. Health insurance and life events are tracked separately.`,
  },
  'field-healthInsuranceAnnual': {
    title: 'Annual health insurance',
    body: `Yearly premium for family health cover plus a buffer for the out-of-pocket cap. <strong>In today's rupees.</strong>
      <br><br><strong>Reference:</strong> ₹50K–₹70K/year for ₹50L–₹1Cr family floater at age 50. <strong>Goes up sharply post-65</strong> (₹1.5L+ is common).
      <br><br>Inflates every year using the <strong>Healthcare inflation</strong> rate above (12–14% by default), <em>not</em> general CPI. This single line item is often the difference between a plan that survives and one that doesn't past age 80.`,
  },
  'field-pensionAnnual': {
    title: 'Pension / rental income',
    body: `Reliable yearly income from <strong>outside the corpus</strong> — Government pension, EPS, NPS annuity, rental from property, family business payout, etc. <strong>In today's rupees per year.</strong>
      <br><br><strong>"Inflate" toggle:</strong> ON for income that grows with CPI (rental, NPS variable). OFF for fixed-forever streams (LIC annuity, most insurance pensions).
      <br><br>This income is added to your withdrawal capacity each year, <strong>directly reducing</strong> what gets drawn from your corpus.`,
  },
  'field-otherIncome': {
    title: 'Other taxable income',
    body: `Other taxable income that is <em>not</em> interest or dividends — freelance, consulting, board fees, royalties, business distributions. <strong>In today's rupees per year.</strong>
      <br><br>Treated as <strong>flat (no inflation)</strong> and added to FD interest when computing your total slab-taxed income for the year. Useful for "what if I keep earning ₹X for 5 years post-retirement" stress tests.
      <br><br>If you expect inflating freelance income, use the Pension field with the inflate toggle ON instead.`,
  },
  'field-lifestyleMid': {
    title: 'Age 65–75 expense multiplier',
    body: `How your spending changes between ages <strong>65–75</strong> compared to your base monthly expense.
      <br><br><strong>Default 0.95</strong> = expenses drop ~5% (empty-nesters, less travel, simpler routines).
      <br><br><strong>Tweak to:</strong><br>
      • <strong>1.0</strong> — no change<br>
      • <strong>0.85</strong> — leaner phase<br>
      • <strong>1.1</strong> — more travel, hobbies
      <br><br>Applied only to the base monthly expense. Health insurance and life events are tracked separately.`,
  },
  'field-lifestyleOld': {
    title: 'Age 75+ expense multiplier',
    body: `Spending change after age <strong>75</strong> — typically <em>rises</em> again because of domestic help, in-home nursing, healthcare not covered by insurance, dependent care.
      <br><br><strong>Default 1.15</strong> = +15% over base.
      <br><br><strong>Tweak to:</strong><br>
      • <strong>1.30+</strong> — fully assisted-living lifestyle<br>
      • <strong>1.00</strong> — simple stay-at-home plan<br>
      • <strong>0.85</strong> — moving in with family
      <br><br>Health insurance premium inflation and any medical life-events are <em>separate</em> from this multiplier.`,
  },
  'field-taxMode': {
    title: 'Tax mode for FD interest',
    body: `How interest from your FD/SCSS bucket is taxed each year.
      <br><br><strong>Slab (FY 25-26):</strong> interest is added to total income and taxed at the new-regime slabs (0% up to ₹4 L · 5% to ₹8 L · 10% to ₹12 L · 15% to ₹16 L · 20% to ₹20 L · 25% to ₹24 L · 30% above). <strong>87A rebate</strong> makes income up to ₹12 L tax-free for residents. Senior citizens get an extra ₹50K deduction u/s <strong>80TTB</strong>.
      <br><br><strong>Flat %:</strong> assume one fixed effective rate (useful for quick stress tests or non-resident scenarios).`,
  },
  'field-flatTaxRate': {
    title: 'Flat tax rate',
    body: `Effective annual tax rate on FD interest, used <strong>only</strong> when "Flat %" tax mode is selected.
      <br><br><strong>Realistic values:</strong><br>
      • <strong>20–30%</strong> if you have multiple income sources at retirement<br>
      • <strong>10–15%</strong> if FD interest is your only income<br>
      • <strong>0%</strong> to bypass tax entirely (pre-tax stress test)
      <br><br>This bypasses the slab calculation, 87A rebate, and 80TTB completely — use only for deterministic checks, not real planning.`,
  },
  'field-isSenior': {
    title: 'Senior citizen (60+)',
    body: `Are you aged <strong>60 or older</strong> as of the current FY? Toggling on unlocks two senior-specific tax breaks:
      <br><br>1) <strong>Section 80TTB</strong> — first ₹50,000/year of bank-interest is fully tax-deductible.<br>
      2) <strong>SCSS eligibility at 8.2%</strong> (vs ~6.5% bank FD) — used by the SCSS-led strategy.
      <br><br>Toggle ON if you're 60+ <em>today</em>; the model assumes senior status throughout the simulation. For "I will be 60 in N years" planning, instead set the <em>Starting age</em> field — the model checks age each year automatically.`,
  },
  'field-spouse': {
    title: 'Spouse on board',
    body: `Are you planning <strong>as a couple</strong> where both spouses retire together?
      <br><br><strong>What changes when ON:</strong><br>
      • <strong>SCSS-led strategy only:</strong> deposit cap doubles ₹30 L → <strong>₹60 L</strong> (two ₹30 L slots). Other strategies do not add SCSS.<br>
      • <strong>Tax (slab mode):</strong> interest and other income are split 50/50 across two filers — each gets their own ₹12 L §87A rebate and ₹50k §80TTB (if Senior is ON). Equity LTCG exemption doubles to ₹2.5 L/year.<br>
      <br><br><strong>What does NOT change:</strong><br>
      • Starting corpus stays <strong>one combined pool</strong> — not split into two accounts.<br>
      • Monthly expense stays your <strong>combined household</strong> total — not halved.<br>
      • If Senior is OFF, SCSS is still not age-gated in the model; use Senior + Spouse for the full couple benefit.`,
  },
  'field-startingAge': {
    title: 'Starting age',
    body: `Your age <strong>at the start of the simulation</strong> — i.e., today's age, not retirement age.
      <br><br>Used to:<br>
      • tag age labels on every chart<br>
      • decide when 80TTB and SCSS kick in (at 60)<br>
      • apply the 65–75 and 75+ lifestyle expense multipliers
      <br><br><strong>Already retired?</strong> Set this to your current age.<br>
      <strong>Planning ahead?</strong> Set to your current age and read the chart from the year you actually retire.`,
  },
  'field-bequestGoal': {
    title: 'Bequest / legacy goal',
    body: `<strong>Inheritance you want left in the corpus</strong> when the simulation ends — for children, charity, or a trust. <strong>In today's rupees</strong> (the model inflates internally for comparison).
      <br><br>This is <strong>not enforced as a hard constraint</strong> — the calculator just shows whether your plan leaves at least this much (inflation-adjusted) at the horizon end.
      <br><br><strong>Default 0</strong> = "spend it all yourself, no inheritance target". Set to a positive number to plan for a specific bequest.`,
  },
};

let openInfoBtn = null;

function showInfoPopover(btn) {
  const key = btn.dataset.info;
  const content = INFO_CONTENT[key];
  const popover = document.getElementById('infoPopover');
  if (!popover || !content) return;
  popover.innerHTML = `
    <div class="info-popover-title">
      <span>${content.title}</span>
      <button class="info-popover-close" aria-label="Close">×</button>
    </div>
    <div class="info-popover-body">${content.body}</div>
  `;
  popover.classList.add('show');
  popover.setAttribute('aria-hidden', 'false');
  positionPopover(btn, popover);
  openInfoBtn = btn;
  popover.querySelector('.info-popover-close').addEventListener('click', hideInfoPopover);
}

function hideInfoPopover() {
  const popover = document.getElementById('infoPopover');
  if (!popover) return;
  popover.classList.remove('show');
  popover.setAttribute('aria-hidden', 'true');
  openInfoBtn = null;
}

function positionPopover(anchor, popover) {
  const rect = anchor.getBoundingClientRect();
  // Render off-screen first to measure
  popover.style.left = '0px'; popover.style.top = '0px';
  const popoverRect = popover.getBoundingClientRect();
  const margin = 8;

  // Default: place to the right of the icon
  let left = rect.right + margin;
  let top = rect.top - 4;

  // If it would go off the right edge, place to the left
  if (left + popoverRect.width > window.innerWidth - margin) {
    left = rect.left - popoverRect.width - margin;
  }
  // If still off-screen on the left (very narrow viewport), centre over the viewport
  if (left < margin) {
    left = Math.max(margin, (window.innerWidth - popoverRect.width) / 2);
    top = rect.bottom + margin;
  }
  // Clip top to viewport
  if (top + popoverRect.height > window.innerHeight - margin) {
    top = Math.max(margin, window.innerHeight - popoverRect.height - margin);
  }
  if (top < margin) top = margin;

  popover.style.left = left + 'px';
  popover.style.top = top + 'px';
}

function setupInfoButtons() {
  // Click delegation — works for current and future info buttons
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.info-btn');
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      if (openInfoBtn === btn) {
        hideInfoPopover();
      } else {
        showInfoPopover(btn);
      }
      return;
    }
    // Click outside the popover closes it
    if (openInfoBtn && !e.target.closest('#infoPopover')) {
      hideInfoPopover();
    }
  });
  // Keyboard: Esc closes, Enter/Space activates info-btn spans (buttons already do this natively)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openInfoBtn) { hideInfoPopover(); return; }
    if ((e.key === 'Enter' || e.key === ' ')
        && e.target.classList && e.target.classList.contains('info-btn')
        && e.target.tagName === 'SPAN') {
      e.preventDefault();
      if (openInfoBtn === e.target) hideInfoPopover();
      else showInfoPopover(e.target);
    }
  });
  // Reposition on resize
  window.addEventListener('resize', () => {
    if (openInfoBtn) {
      const popover = document.getElementById('infoPopover');
      if (popover) positionPopover(openInfoBtn, popover);
    }
  });
  // Reposition on scroll (popover is position:fixed, so anchor moves)
  window.addEventListener('scroll', () => {
    if (openInfoBtn) {
      const popover = document.getElementById('infoPopover');
      if (popover) positionPopover(openInfoBtn, popover);
    }
  }, { passive: true });
}

/* ════════════════════════════════════════════════════════════════════════
   EVENT WIRING
   ════════════════════════════════════════════════════════════════════════ */
function setupEvents() {
  // Inputs — sync slider <-> number pairs
  const PAIRS = [
    'totalCorpus', 'fdPercent', 'fdRate', 'equityRate', 'equityVolatility',
    'monthlyExpense', 'inflation', 'healthInflation', 'flatTaxRate',
    'otherIncome', 'healthInsuranceAnnual', 'pensionAnnual', 'maxYears',
    'lifestyleMid', 'lifestyleOld', 'bequestGoal', 'startingAge',
  ];
  PAIRS.forEach(k => {
    const num = document.getElementById(k);
    const range = document.getElementById(k + 'Range');
    if (!num || !range) return;
    function update(val) {
      const n = parseFloat(val);
      if (!Number.isFinite(n)) return;
      state.inputs[k] = n;
      if (num.value != n) num.value = n;
      if (range.value != n) range.value = n;
      scheduleUpdate();
      markPresetActive(null);
    }
    num.addEventListener('input', e => update(e.target.value));
    range.addEventListener('input', e => update(e.target.value));
  });

  // Boolean toggles
  ['isSenior', 'spouse', 'pensionInflated'].forEach(k => {
    const el = document.getElementById(k);
    if (!el) return;
    el.addEventListener('change', e => {
      state.inputs[k] = e.target.checked;
      scheduleUpdate();
    });
  });

  // Tax mode segmented
  document.querySelectorAll('input[name="taxMode"]').forEach(r => {
    r.addEventListener('change', () => {
      state.inputs.taxMode = r.checked ? r.value : state.inputs.taxMode;
      document.getElementById('flatTaxField').style.display = state.inputs.taxMode === 'flat' ? '' : 'none';
      scheduleUpdate();
    });
  });

  // Presets
  document.querySelectorAll('.preset-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset;
      state.inputs = { ...PRESETS[preset] };
      markPresetActive(preset);
      renderEventsList();
      renderAll();
      saveState();
    });
  });

  // Strategy tabs
  document.querySelectorAll('#strategyTabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#strategyTabs .tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.activeStrategy = tab.dataset.strategy;
      const sim = ({ user: simulateUserStrategy, improved: simulateImproved, swp: simulateSWP, pureFD: simulatePureFD, annuity: simulateAnnuity }[state.activeStrategy])();
      renderTrajectory(sim);
    });
  });

  // Reset
  document.getElementById('resetBtn').addEventListener('click', () => {
    state.inputs = { ...DEFAULTS };
    markPresetActive('base');
    renderEventsList();
    renderAll();
    saveState();
  });

  // Events: add / clear
  document.getElementById('addEventBtn').addEventListener('click', () => {
    const events = state.inputs.events || (state.inputs.events = []);
    const nextId = events.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1;
    const lastYear = events.length ? Math.max(...events.map(e => e.year || 0)) : 0;
    events.push({ id: nextId, year: Math.min(state.inputs.maxYears, lastYear + 3 || 5), amount: 1000000, label: 'New event' });
    renderEventsList();
    renderAll();
    saveState();
    markPresetActive(null);
    // Focus the new amount input
    setTimeout(() => {
      const rows = document.querySelectorAll('#eventsRows .event-row');
      const last = rows[rows.length - 1];
      if (last) last.querySelector('.event-amount').focus();
    }, 0);
  });
  document.getElementById('clearEventsBtn').addEventListener('click', () => {
    state.inputs.events = [];
    renderEventsList();
    renderAll();
    saveState();
    markPresetActive(null);
  });

  // Theme
  document.getElementById('themeBtn').addEventListener('click', toggleTheme);

  // Export CSV
  document.getElementById('exportBtn').addEventListener('click', exportCSV);

  // Re-render on resize for chart sizes
  let resizeT;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => renderAll(), 150);
  });
}

let updateT;
function scheduleUpdate() {
  clearTimeout(updateT);
  updateT = setTimeout(() => { renderAll(); saveState(); }, 50);
}

function markPresetActive(preset) {
  document.querySelectorAll('.preset-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.preset === preset);
  });
}

/* ─── Theme toggle ─── */
function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  state.darkMode = theme === 'dark';
  const icon = document.getElementById('themeIcon');
  if (theme === 'dark') {
    icon.innerHTML = `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>`;
  } else {
    icon.innerHTML = `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>`;
  }
  try { localStorage.setItem('retire-theme', theme); } catch (e) {}
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  setTheme(cur === 'dark' ? 'light' : 'dark');
  refreshChartColors();
  renderAll();  // re-render charts to pick up new colours
}

/* ─── CSV export ─── */
function exportCSV() {
  const sim = simulateUserStrategy();
  const rows = [
    ['Year', 'Age', 'Lifestyle ×', 'Monthly expense', 'Life event ₹', 'Life event(s)', 'Annual outflow', 'FD interest gross', 'Tax on interest', 'FD interest net', 'Pension', 'FD principal drawn', 'FD end', 'Equity end', 'Total', 'Total (real)', 'Withdrawal rate %', 'Equity tax', 'Note'],
  ];
  sim.years.forEach(y => rows.push([
    y.yr, y.age, y.lifestyleMult.toFixed(2),
    Math.round(y.monthlyExpense), Math.round(y.eventOut),
    (y.eventItems || []).map(e => `${e.label} (${Math.round(e.amount)})`).join('; '),
    Math.round(y.totalOutflow),
    Math.round(y.gross), Math.round(y.tax), Math.round(y.net),
    Math.round(y.pension || 0),
    Math.round(y.fdDraw), Math.round(y.fdEnd), Math.round(y.eqEnd),
    Math.round(y.total), Math.round(y.real),
    (y.withdrawalRate * 100).toFixed(2),
    Math.round(y.eqTax || 0),
    y.rebalanced ? 'Rebalance (half equity → FD)' : (y.eqTax > 0 ? 'Equity LTCG' : ''),
  ]));
  const csv = rows.map(r => r.map(v => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
  const blob = new Blob(["\ufeff" + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `retirement-${(state.inputs.totalCorpus/1e7).toFixed(1)}cr-${state.inputs.monthlyExpense/1000}k.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ─── FAQ accordion: opening one item closes the others ─── */
function setupFAQ() {
  const items = document.querySelectorAll('.faq-list .faq-item');
  if (!items.length) return;
  items.forEach(item => {
    item.addEventListener('toggle', () => {
      if (!item.open) return;
      items.forEach(other => {
        if (other !== item && other.open) other.open = false;
      });
    });
  });
}

/* ════════════════════════════════════════════════════════════════════════
   BOOT
   ════════════════════════════════════════════════════════════════════════ */
function boot() {
  // Theme init
  const savedTheme = (() => { try { return localStorage.getItem('retire-theme'); } catch (e) { return null; } })();
  setTheme(savedTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  refreshChartColors();
  // Wire events
  setupEvents();
  setupInfoButtons();
  setupFAQ();
  // Dynamic year in brand subtitle
  const yearEl = document.getElementById('brandYear');
  if (yearEl) yearEl.textContent = new Date().getFullYear();
  // Render UI
  renderEventsList();
  renderAll();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
