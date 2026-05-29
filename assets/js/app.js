/*!
 * Will My Money Last - India Retirement Drawdown (Decumulation) Calculator
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
  taxHarvesting: true,            // crystallise LTCG up to yearly exemption (cost-basis step-up)
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
  mode: 'simple',  // 'simple' | 'advanced' — UI detail level, not a calc input (resolved in boot)
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

/**
 * Tax-gain harvesting: sell-and-rebuy equity to crystallise gains up to the
 * remaining yearly LTCG exemption. The position size is unchanged; only the
 * cost basis steps up by the harvested amount — no tax due, no risk taken.
 * In a down year (value < cost) nothing is done; long-term capital losses
 * already net against gains automatically via proportional cost basis on the
 * normal `withdrawEquity` path. Indian law lets LT losses carry forward 8 yr,
 * but the simulation operates one year at a time so we do not model that.
 *
 * Returns the new cost basis and the gain harvested (0 if disabled or no gain).
 */
function harvestLtcg(value, cost, inp, exemptionLeft) {
  if (!inp.taxHarvesting || exemptionLeft <= 0 || value <= cost) {
    return { rc: cost, harvested: 0 };
  }
  const unrealised = value - cost;
  const harvested = Math.min(exemptionLeft, unrealised);
  return { rc: cost + harvested, harvested };
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
  let totalHarvested = 0;
  let inflationFactor = 1;
  let totalEvents = 0;

  // Normally the plan length; an optional larger horizon lets us discover the
  // TRUE depletion year when money outlasts the plan (used for the headline).
  const horizon = opts.horizon || inp.maxYears;
  for (let yr = 1; yr <= horizon; yr++) {
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

    // Tax-gain harvesting — crystallise gains up to the leftover yearly exemption.
    const h = harvestLtcg(eq, eqCost, inp, exemptionLeft);
    eqCost = h.rc;
    exemptionLeft = Math.max(0, exemptionLeft - h.harvested);
    totalHarvested += h.harvested;

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
      rebalanced, eqTax: eqTaxThisYr, harvested: h.harvested,
      lifestyleMult: lMult,
      withdrawalRate,
      eqReturn,
    });

    baseAnnualExp *= (1 + inp.inflation / 100);
    health *= (1 + (inp.healthInflation || 12) / 100);
    if (inp.pensionInflated) pension *= (1 + inp.inflation / 100);

    if (total <= 0) break;
  }

  return makeResult(years, { totalFDTax, totalEqTax, totalSpent, rebalances, totalEvents, totalHarvested }, inp);
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
  let totalHarvested = 0;
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

    // Tax-gain harvesting — use any remaining yearly exemption to step up cost basis.
    const h = harvestLtcg(eq, eqCost, inp, exemptionLeft);
    eqCost = h.rc;
    exemptionLeft = Math.max(0, exemptionLeft - h.harvested);
    totalHarvested += h.harvested;

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
      rebalanced: false, eqTax: eqTaxThisYr, harvested: h.harvested,
      lifestyleMult: lMult, withdrawalRate, eqReturn,
    });

    baseAnnualExp *= (1 + inp.inflation / 100);
    health *= (1 + (inp.healthInflation || 12) / 100);
    if (inp.pensionInflated) pension *= (1 + inp.inflation / 100);
    if (total <= 0) break;
  }

  return makeResult(years, { totalFDTax, totalEqTax, totalSpent, rebalances, totalEvents, totalHarvested }, inp);
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
      rebalanced: false, eqTax: 0, harvested: 0,
      lifestyleMult: lMult, withdrawalRate, eqReturn: 0,
    });
    baseAnnualExp *= (1 + inp.inflation / 100);
    health *= (1 + (inp.healthInflation || 12) / 100);
    if (inp.pensionInflated) pension *= (1 + inp.inflation / 100);
    if (fd <= 0) break;
  }
  return makeResult(years, { totalFDTax, totalEqTax: 0, totalSpent, rebalances: 0, totalEvents, totalHarvested: 0 }, inp);
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
  let totalHarvested = 0;
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

    // Tax-gain harvesting — both arbitrage (equity-taxed) and equity share the same
    // ₹1.25 L LTCG bucket. Harvest equity first (longer horizon → more gain accrual),
    // then arbitrage with whatever exemption is left.
    let harvestedThisYr = 0;
    const he = harvestLtcg(eq, eqCost, inp, exemptionLeft);
    eqCost = he.rc;
    exemptionLeft = Math.max(0, exemptionLeft - he.harvested);
    harvestedThisYr += he.harvested;
    const ha = harvestLtcg(arbitrage, arbCost, inp, exemptionLeft);
    arbCost = ha.rc;
    exemptionLeft = Math.max(0, exemptionLeft - ha.harvested);
    harvestedThisYr += ha.harvested;
    totalHarvested += harvestedThisYr;

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
      rebalanced: false, eqTax: eqTaxThisYr, harvested: harvestedThisYr,
      lifestyleMult: lMult, withdrawalRate, eqReturn,
    });
    baseAnnualExp *= (1 + inp.inflation / 100);
    health *= (1 + (inp.healthInflation || 12) / 100);
    if (inp.pensionInflated) pension *= (1 + inp.inflation / 100);
    if (total <= 0) break;
  }

  return makeResult(years, { totalFDTax, totalEqTax, totalSpent, rebalances, totalEvents, totalHarvested }, inp);
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
      rebalanced: false, eqTax: 0, harvested: 0,
      lifestyleMult: lMult,
      withdrawalRate: totalOutflow / Math.max(1, startCorpus),
      eqReturn: 0,
      annuityRate, shortfall,
    });
    baseAnnualExp *= (1 + inp.inflation / 100);
    health *= (1 + (inp.healthInflation || 12) / 100);
    if (inp.pensionInflated) pension *= (1 + inp.inflation / 100);
  }
  const r = makeResult(years, { totalFDTax, totalEqTax: 0, totalSpent, rebalances: 0, totalEvents, totalHarvested: 0 }, inp);
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
  const { categories, series, height = 320, valueSuffix = '', filled = false, formatTooltip, ariaLabel = '' } = opts;
  if (!container || categories.length === 0) return;
  const chartDesc = ariaLabel || series.map(s => s.name).filter(Boolean).join(', ');
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
    <svg class="chart-svg" role="img" aria-label="${chartDesc.replace(/"/g, '&quot;')}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
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
  const { categories, series, height = 240, valueSuffix = '', formatTooltip, ariaLabel = '' } = opts;
  if (!container || categories.length === 0) return;
  const chartDesc = ariaLabel || series.map(s => s.name).filter(Boolean).join(', ');
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
    <svg class="chart-svg" role="img" aria-label="${chartDesc.replace(/"/g, '&quot;')}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
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
const animRegistry = new Map();   // el -> { value, raf }
// Cancel any in-flight count-up on this element and forget its last value, so a
// direct textContent assignment (e.g. "Never") can't be clobbered by a stale frame.
function cancelAnim(el) {
  const prev = animRegistry.get(el);
  if (prev && prev.raf) cancelAnimationFrame(prev.raf);
  animRegistry.delete(el);
}
function animateValue(el, to, formatter, duration = 600) {
  if (!el) return;
  const prev = animRegistry.get(el);
  const from = prev && typeof prev.value === 'number' ? prev.value : to;
  if (prev && prev.raf) cancelAnimationFrame(prev.raf);   // supersede the previous animation
  const rec = { value: to, raf: 0 };
  animRegistry.set(el, rec);
  if (from === to) { el.textContent = formatter(to); return; }
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const current = from + (to - from) * eased;
    el.textContent = formatter(current);
    rec.raf = t < 1 ? requestAnimationFrame(step) : 0;
  }
  rec.raf = requestAnimationFrame(step);
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
// Display ceiling for longevity — beyond this we just show "99+".
const LONGEVITY_CAP = 100;

// The plan-length loop caps yearsLasted at maxYears, so a plan that comfortably
// outlasts its horizon reads as "maxYears". To show the TRUE number of years the
// money lasts, keep simulating past the plan (only when it survived the plan).
function trueYearsLasted(sim, inp) {
  if (sim.yearsLasted < sim.maxYears) return sim.yearsLasted;       // ran out within the plan
  if (sim.maxYears >= LONGEVITY_CAP) return sim.yearsLasted;        // plan already at/over the cap
  return simulateUserStrategy(inp, { horizon: LONGEVITY_CAP }).yearsLasted;
}

function renderHero(sim) {
  const inp = state.inputs;
  const planYears = sim.maxYears;
  const planEndAge = inp.startingAge + planYears;     // age at the end of the plan
  const coversPlan = sim.yearsLasted >= planYears;    // did the money last the whole plan?
  const trueYears = trueYearsLasted(sim, inp);        // actual years the money lasts
  const beyond = trueYears > 99;                      // outlasts 99 years (show "99+")
  const depleteAge = inp.startingAge + trueYears;     // age the money actually runs out

  setNum('kpiYears', trueYears, v => beyond ? '99+ Years' : `${Math.round(v)} Years`);
  setNum('kpiFinalReal', sim.finalReal, v => fmtCr(v));

  // "Years money lasts" sub — now states plan coverage
  document.getElementById('kpiYearsSub').textContent = coversPlan
    ? (beyond ? `covers your ${planYears}-year plan, with room to spare` : `covers your full ${planYears}-year plan`)
    : `${planYears - trueYears} years short of your ${planYears}-year plan`;

  // "Money runs out at age" — uses the true depletion age
  const depleteEl = document.getElementById('kpiDepleteAge');
  const depleteSub = document.getElementById('kpiDepleteAgeSub');
  if (depleteEl) {
    depleteEl.classList.remove('success', 'info', 'warning', 'danger');
    if (beyond) {
      cancelAnim(depleteEl);  // stop any in-flight count-up so "Never" sticks
      depleteEl.textContent = 'Never';
      depleteEl.classList.add('success');
      depleteSub.textContent = `your money outlasts 99 years`;
    } else {
      setNum('kpiDepleteAge', depleteAge, v => Math.round(v).toString());
      depleteEl.classList.add(coversPlan ? 'success' : (trueYears < 20 ? 'danger' : 'warning'));
      depleteSub.textContent = coversPlan
        ? `${trueYears - planYears > 0 ? `${trueYears - planYears} years after your plan ends` : `right as your plan ends`} (age ${planEndAge})`
        : `that's ${trueYears} years from now`;
    }
  }

  // Final real
  document.getElementById('kpiFinalRealSub').textContent = `in today's value, after ${sim.years.length} years of rising prices`;

  // First FD draw
  document.getElementById('kpiFirstDraw').textContent = sim.firstDrawYr ? `Year ${sim.firstDrawYr}` : 'Never';
  document.getElementById('kpiFirstDrawSub').textContent =
    sim.firstDrawYr ? `your spending passes your interest` : `interest always covers your spending`;

  // Tone for years — green only when it covers the whole plan
  const yearsEl = document.getElementById('kpiYears');
  yearsEl.classList.remove('success', 'warning', 'danger', 'info');
  if (coversPlan) yearsEl.classList.add('success');
  else if (trueYears >= 30) yearsEl.classList.add('info');
  else if (trueYears >= 20) yearsEl.classList.add('warning');
  else yearsEl.classList.add('danger');

  // Verdict callout — written in neutral, universal voice
  const verdict = document.getElementById('verdictCallout');
  const bequest = inp.bequestGoal || 0;
  const meetsGoal = sim.finalReal >= bequest;
  const eventsTotal = (inp.events || []).reduce((s, e) => s + (e.amount || 0), 0);
  const eventsLine = eventsTotal > 0 ? ` This includes ${(inp.events||[]).length} big one-off cost(s) adding up to ${fmtCr(eventsTotal)} in today's money.` : '';
  const longevityLine = beyond
    ? `Your money outlasts 99 years — effectively for life.`
    : `In all, your money lasts about ${trueYears} years — to age ${depleteAge}.`;
  const shortBy = planYears - trueYears;
  let tone, title, body;
  if (coversPlan && meetsGoal) {
    tone = 'success'; title = `Your money covers your full ${planYears}-year plan · age ${inp.startingAge} to ${planEndAge}`;
    body = `${longevityLine} You finish the plan with <strong>${fmtCr(sim.finalCorpus)}</strong> (worth <strong>${fmtCr(sim.finalReal)} in today's money</strong>).${bequest > 0 ? ` That's enough to leave your ${fmtCr(bequest)} goal, with ${fmtCr(sim.finalReal - bequest)} to spare.` : ''} ${sim.rebalances ? `You moved money from stocks to safe savings ${sim.rebalances} time(s)${sim.firstRebalanceYr ? ` (first in year ${sim.firstRebalanceYr})` : ''}.` : ''}${eventsLine}`;
  } else if (coversPlan && !meetsGoal) {
    tone = 'warning'; title = `Your money covers your ${planYears}-year plan — but it's short of what you wanted to leave behind`;
    body = `${longevityLine} But ${fmtCr(sim.finalReal)} in today's money is ${fmtCr(bequest - sim.finalReal)} short of the ${fmtCr(bequest)} you hoped to leave. Save a bit more, spend a bit less, or aim to leave a smaller amount.${eventsLine}`;
  } else if (trueYears >= 30) {
    tone = 'info'; title = `Your money lasts ${trueYears} years · runs out at age ${depleteAge}, before your ${planYears}-year plan`;
    body = `That's ${shortBy} year${shortBy === 1 ? '' : 's'} short of your ${planYears}-year plan (age ${planEndAge}). It's still a long stretch — check the luck test below to see how it holds up if the market has a rough start.${eventsLine}`;
  } else if (trueYears >= 20) {
    tone = 'warning'; title = `Your money lasts ${trueYears} years · runs out at age ${depleteAge} — ${shortBy} year${shortBy === 1 ? '' : 's'} short of your plan`;
    body = `To reach the end of your ${planYears}-year plan (age ${planEndAge}), you'll need to spend less, keep more in the stock market, or earn a bit more. Try the "Careful" button and look at the luck test below.${eventsLine}`;
  } else {
    tone = 'danger'; title = `Your money only lasts ${trueYears} years · runs out at age ${depleteAge} — well short of your plan`;
    body = `Your money runs out ${shortBy} years before your ${planYears}-year plan ends (age ${planEndAge}). Spend less, keep more in the stock market, push back big one-off costs, or build up more savings before you stop working.${eventsLine}`;
  }
  verdict.className = 'callout callout-' + tone;
  const icons = { success: '✓', info: 'i', warning: '!', danger: '×' };
  verdict.innerHTML = `<div class="callout-icon" aria-hidden="true">${icons[tone]}</div>
    <div class="callout-body"><div class="callout-title">${title}</div>${body}</div>`;

  // Sync the floating result dock — leads with plan coverage (the headline answer)
  const dock = document.getElementById('resultDock');
  if (dock) {
    const coverageTone = coversPlan ? 'success' : (trueYears < 20 ? 'danger' : 'warning');
    const yrsText = beyond ? '99+' : trueYears;
    dock.dataset.tone = coverageTone;
    document.getElementById('dockIcon').textContent = coversPlan ? '\u2713' : '!';
    document.getElementById('dockHeadline').textContent = coversPlan
      ? `Money lasts your whole plan (${planYears}\u2011yrs)`   // U+2011 keeps "(50-yrs)" intact on wrap
      : `Money runs out too soon`;
    document.getElementById('dockDetail').textContent = coversPlan
      ? `covers ${yrsText} yrs \u00b7 ${fmtCr(sim.finalReal)} left at the end`
      : `covers only ${yrsText} yrs \u00b7 runs out at age ${depleteAge}`;
    dock.setAttribute('aria-label', coversPlan
      ? `Good news: your money lasts your whole ${planYears}-year plan — about ${beyond ? 'over 99' : trueYears} years in all, leaving ${fmtCr(sim.finalReal)} in today's value. Tap for the full result.`
      : `Heads up: your money runs out at age ${depleteAge}, ${shortBy} year${shortBy === 1 ? '' : 's'} before your ${planYears}-year plan ends. Tap for the full result.`);
  }
  requestDockUpdate();
}

/* ─── Inputs feedback (helper text under sliders) ─── */
function syncMethodPresets(fdPct) {
  document.querySelectorAll('.method-preset').forEach(btn => {
    const p = parseInt(btn.dataset.fdPct, 10);
    const on = p === fdPct;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function renderMethodSplit(inp = state.inputs) {
  const fdPct = Math.max(0, Math.min(100, inp.fdPercent));
  const eqPct = 100 - fdPct;
  const fdAmt = inp.totalCorpus * fdPct / 100;
  const eqAmt = inp.totalCorpus - fdAmt;
  const fdPctEl = document.getElementById('methodFdPct');
  if (!fdPctEl) return;
  const eqPctEl = document.getElementById('methodEqPct');
  const fdAmtEl = document.getElementById('methodFdAmt');
  const eqAmtEl = document.getElementById('methodEqAmt');
  if (fdPctEl) fdPctEl.textContent = `${fdPct}%`;
  if (eqPctEl) eqPctEl.textContent = `${eqPct}%`;
  if (fdAmtEl) fdAmtEl.textContent = fmtCr(fdAmt);
  if (eqAmtEl) eqAmtEl.textContent = fmtCr(eqAmt);
  const trackFdPct = document.getElementById('trackFdPct');
  const trackEqPct = document.getElementById('trackEqPct');
  if (trackFdPct) trackFdPct.textContent = `${fdPct}%`;
  if (trackEqPct) trackEqPct.textContent = `${eqPct}%`;
  const hint = document.getElementById('fdPercentHint');
  if (hint) hint.textContent = `${fdPct}% in bank or FD (${fmtCr(fdAmt)}), ${eqPct}% in stocks (${fmtCr(eqAmt)})`;
  const rangeWrap = document.getElementById('planSplitRange');
  if (rangeWrap) rangeWrap.style.setProperty('--fd-pct', `${fdPct}%`);
  syncMethodPresets(fdPct);
}

function renderInputsFeedback() {
  const inp = state.inputs;
  document.getElementById('totalCorpusHint').textContent = fmtCr(inp.totalCorpus);
  renderMethodSplit(inp);
  const yr10 = inp.monthlyExpense * Math.pow(1 + inp.inflation/100, 9);
  document.getElementById('monthlyExpenseHint').textContent = `Now ${fmtL(inp.monthlyExpense)}/m → in 10 yrs ${fmtL(yr10)}/m`;
  const maxYearsHint = document.getElementById('maxYearsHint');
  if (maxYearsHint) maxYearsHint.textContent = `${inp.maxYears} yrs → through age ${inp.startingAge + inp.maxYears}`;
  const bequestHint = document.getElementById('bequestHint');
  if (bequestHint) bequestHint.textContent = inp.bequestGoal > 0 ? `that's ${fmtCr(inp.bequestGoal * Math.pow(1 + inp.inflation/100, inp.maxYears))} in year ${inp.maxYears}` : "today's money (0 = none)";

  // Sync all paired inputs
  const ALL_KEYS = ['totalCorpus', 'fdPercent', 'fdRate', 'equityRate', 'equityVolatility', 'monthlyExpense', 'inflation', 'healthInflation', 'flatTaxRate', 'otherIncome', 'healthInsuranceAnnual', 'pensionAnnual', 'maxYears', 'lifestyleMid', 'lifestyleOld', 'bequestGoal', 'startingAge'];
  ALL_KEYS.forEach(k => {
    const a = document.getElementById(k);
    const b = document.getElementById(k + 'Range');
    if (a && document.activeElement !== a) a.value = inp[k];
    if (b && document.activeElement !== b) b.value = inp[k];
  });
  ['isSenior', 'spouse', 'pensionInflated', 'taxHarvesting'].forEach(k => {
    const el = document.getElementById(k);
    if (el) el.checked = !!inp[k];
  });
  document.getElementById('taxMode-slab').checked = inp.taxMode === 'slab';
  document.getElementById('taxMode-flat').checked = inp.taxMode === 'flat';

  document.getElementById('sampleCorpus').textContent = (inp.totalCorpus / 1e7).toFixed(1).replace(/\.0$/, '');

  // Events total hint
  const evTotal = (inp.events || []).reduce((s, e) => s + (e.amount || 0), 0);
  const evCount = (inp.events || []).length;
  const elHint = document.getElementById('eventsTotalHint');
  if (elHint) elHint.textContent = evCount === 0
    ? 'No big one-off costs added yet.'
    : `${evCount} cost${evCount > 1 ? 's' : ''} · ${fmtCr(evTotal)} total, in today's money`;
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
    container.innerHTML = `<div class="events-empty">No big one-off costs yet. Tap "+ Add cost" to add one — a wedding, college, a big medical bill, a car, a trip, and so on.</div>`;
    return;
  }
  const lastIdx = inp.events.length - 1;
  container.innerHTML = inp.events.map((e, idx) => `
    <div class="event-row" data-idx="${idx}">
      <div class="event-reorder" role="group" aria-label="Reorder event">
        <button type="button" class="event-move event-move-up" aria-label="Move up" title="Move up"${idx === 0 ? ' disabled' : ''}>↑</button>
        <button type="button" class="event-move event-move-down" aria-label="Move down" title="Move down"${idx === lastIdx ? ' disabled' : ''}>↓</button>
      </div>
      <input type="number" class="event-year" min="1" max="${inp.maxYears}" value="${e.year}" aria-label="Year of one-off cost" autocomplete="off" />
      <input type="number" class="event-amount" min="0" step="50000" value="${e.amount}" aria-label="Amount in today's rupees" autocomplete="off" />
      <input type="text" class="event-label" placeholder="Description" value="${(e.label || '').replace(/"/g, '&quot;')}" aria-label="Description of one-off cost" autocomplete="off" />
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
    series: [{ name: 'Spending per month', data: expenseSeries, color: 'var(--warning)' }],
    height: 240,
    valueSuffix: ' L',
    filled: true,
    ariaLabel: 'Monthly spending rising with inflation, year by year',
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
      { name: 'Safe savings', data: sampled.map(y => +(y.fdEnd / 1e7).toFixed(2)), color: 'var(--chart-1)' },
      { name: 'Stock market', data: sampled.map(y => +(y.eqEnd / 1e7).toFixed(2)), color: 'var(--chart-2)' },
      { name: 'Total (future ₹)', data: sampled.map(y => +(y.total / 1e7).toFixed(2)), color: 'var(--chart-3)' },
      { name: "Total (today's value)", data: sampled.map(y => +(y.real / 1e7).toFixed(2)), color: 'var(--chart-4)' },
    ],
    height: 360, valueSuffix: ' Cr',
    ariaLabel: 'Savings trajectory — safe savings, stocks, and total over time',
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
    { name: 'Interest after tax', data: slice.map(y => +(y.net / 1e5).toFixed(2)), color: 'var(--info)' },
    { name: 'Yearly spending', data: slice.map(y => +((y.totalOutflow - y.eventOut) / 1e5).toFixed(2)), color: 'var(--warning)' },
    { name: 'Taken from savings', data: slice.map(y => +(y.fdDraw / 1e5).toFixed(2)), color: 'var(--danger)' },
  ];
  if (hasPension) series.push({ name: 'Pension / rent', data: slice.map(y => +((y.pension || 0) / 1e5).toFixed(2)), color: 'var(--chart-6)' });
  if (hasEvents) series.push({ name: 'One-off cost', data: slice.map(y => +(y.eventOut / 1e5).toFixed(2)), color: 'var(--chart-5)' });

  renderLineChart(document.getElementById('cashflowChart'), {
    categories: slice.map(y => `Y${y.yr}`),
    series,
    height: 320, valueSuffix: ' L',
    ariaLabel: 'Yearly cashflow — interest, spending, and withdrawals',
    formatTooltip: (v) => '₹' + v.toFixed(2) + ' L',
  });
}

/* ─── Year-by-year table ─── */
function renderYearly(sim) {
  const N = Math.min(40, sim.years.length);
  const rows = sim.years.slice(0, N).map(y => {
    const noteParts = [];
    if (y.rebalanced) noteParts.push(`<span class="pill pill-warning">moved to safe · tax ${fmtL(y.eqTax)}</span>`);
    else if (y.eqTax > 0) noteParts.push(`<span class="pill pill-info">stock tax ${fmtL(y.eqTax)}</span>`);
    else if (y.surplus > 0) noteParts.push(`<span class="text-quiet">${fmtL(y.surplus)} spare</span>`);
    if (y.harvested > 0) noteParts.push(`<span class="pill pill-success" title="Booked ${fmtL(y.harvested)} of profit tax-free, lowering future tax by about ${fmtL(y.harvested * (state.inputs.ltcgRate || 12.5) / 100)}">tax-saver ${fmtL(y.harvested)}</span>`);
    const note = noteParts.length ? noteParts.join(' ') : '—';
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
    { key: 'pureFD', name: 'All in bank deposits (FD)', desc: 'Everything stays in fixed deposits. No market risk, but rising prices slowly eat away what your money can buy.' },
    { key: 'user', name: 'Half safe, half stocks', desc: 'Half kept safe, half in the stock market. Live off the interest first; when the safe side runs out, sell some stocks to top it up. Simple and easy to follow.' },
    { key: 'improved', name: "Senior citizens' scheme", desc: `${inp.spouse ? '₹60 Lakh (₹30 Lakh each)' : '₹30 Lakh'} in the government's senior scheme at 8.2%, the rest in safe savings and stocks. Each year, move a tax-free slice of stock profit over to the safe side. Higher, safer return — for age 60+.` },
    { key: 'swp', name: 'Low-tax mutual funds', desc: 'Keep your "safe" money in special low-risk funds taxed like stocks (usually far less tax than a bank deposit), and take an automatic monthly payout. Usually the most tax-friendly option.' },
    { key: 'annuity', name: 'Pension for life', desc: `Hand the whole amount to an insurance company. They pay you a fixed amount every month for life at about ${annuityRateFor(inp.startingAge).toFixed(1)}% (with the money returned to family at the end). No market risk, but the fixed amount buys less and less as prices rise.` },
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
    ariaLabel: 'Years each retirement plan lasts',
    formatTooltip: (v) => `${Math.round(v)} years`,
  });
  renderBarChart(document.getElementById('compareCorpusChart'), {
    categories: cats,
    series: [{ name: 'Real corpus (₹ Cr)', data: STR.map(s => +(sims[s.key].finalReal / 1e7).toFixed(2)), color: 'var(--chart-2)' }],
    height: 220, valueSuffix: ' Cr',
    ariaLabel: 'Money left at the end of each plan, in today\'s value',
    formatTooltip: (v) => fmtCr(v * 1e7),
  });

  // Table
  document.querySelector('#compareTable tbody').innerHTML = STR.map(s => {
    const sim = sims[s.key];
    const harvested = sim.totalHarvested || 0;
    const harvestSaved = harvested * (inp.ltcgRate || 12.5) / 100;
    const harvestCell = harvested > 0
      ? `<span title="Stock profit booked tax-free over the plan — saving about ${fmtCr(harvestSaved)} in future tax">${fmtCr(harvested)} <span class="text-quiet">(saved ${fmtCr(harvestSaved)})</span></span>`
      : (inp.taxHarvesting ? '<span class="text-quiet">no profit to book</span>' : '<span class="text-quiet">off</span>');
    return `<tr>
      <td>${s.name}</td>
      <td>${sim.yearsLasted >= sim.maxYears ? sim.maxYears + '+' : sim.yearsLasted}</td>
      <td>${fmtCr(sim.finalCorpus)}</td>
      <td>${fmtCr(sim.finalReal)}</td>
      <td>${fmtCr(sim.totalFDTax + sim.totalEqTax)}</td>
      <td>${harvestCell}</td>
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
      <span class="stat-label">Chance your plan works</span>
      <span class="stat-value ${tone}">${successPct}</span>
      <span class="stat-sub">money lasts all ${inp.maxYears} years${inp.bequestGoal > 0 ? ' and meets your goal' : ''}</span>
    </div>
    <div class="stat-card">
      <span class="stat-label">Middle outcome</span>
      <span class="stat-value">${fmtCr(mc.finalP50)}</span>
      <span class="stat-sub">money left at the end, today's value</span>
    </div>
    <div class="stat-card">
      <span class="stat-label">Bad-luck case</span>
      <span class="stat-value ${mc.finalP10 > 0 ? '' : 'danger'}">${fmtCr(mc.finalP10)}</span>
      <span class="stat-sub">1 in 10 runs end below this</span>
    </div>
    <div class="stat-card">
      <span class="stat-label">Worst run lasted</span>
      <span class="stat-value ${worstYears < 20 ? 'danger' : worstYears < 30 ? 'warning' : ''}">${worstYears} yrs</span>
      <span class="stat-sub">out of ${inp.maxYears} years</span>
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
      name: 'Chance money is left',
      data: cats.map((_, i) => +(mc.survivalCurve[Math.min(mc.survivalCurve.length-1, i * step)] * 100).toFixed(1)),
      color: 'var(--info)',
    }],
    height: 280,
    valueSuffix: '%',
    filled: true,
    ariaLabel: 'Chance your money is still there each year, across 500 market simulations',
    formatTooltip: v => v.toFixed(1) + '% of runs',
  });

  // Bands chart: P10, P50, P90 of real corpus
  renderLineChart(document.getElementById('mcBandsChart'), {
    categories: cats,
    series: [
      { name: 'Good case (top 10%)', data: cats.map((_, i) => +(mc.percentiles.p90[Math.min(years-1, i * step)] / 1e7).toFixed(2)), color: 'var(--chart-2)' },
      { name: 'Middle case',          data: cats.map((_, i) => +(mc.percentiles.p50[Math.min(years-1, i * step)] / 1e7).toFixed(2)), color: 'var(--chart-1)' },
      { name: 'Bad case (bottom 10%)', data: cats.map((_, i) => +(mc.percentiles.p10[Math.min(years-1, i * step)] / 1e7).toFixed(2)), color: 'var(--chart-4)' },
    ],
    height: 280,
    valueSuffix: ' Cr',
    ariaLabel: 'Range of outcomes — good, middle, and bad cases in today\'s value',
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
    series: [{ name: 'Number of runs', data: counts, color: 'var(--chart-6)' }],
    height: 240,
    valueSuffix: '',
    ariaLabel: 'Distribution of final outcomes across 500 simulations',
    formatTooltip: v => Math.round(v) + ' runs',
  });

  // Interpretation callout
  const interp = document.getElementById('mcInterpretation');
  let title, body;
  if (mc.successRate >= 0.95) {
    title = `Very safe — your plan works ${successPct} of the time`;
    body = `Even with random good and bad market years, your money lasts. The worst run of all still lasted ${worstYears} years. You have a comfortable cushion.`;
  } else if (mc.successRate >= 0.80) {
    title = `Pretty safe — your plan works ${successPct} of the time`;
    body = `Above 80% is fine for most people. In about ${(100 - mc.successRate*100).toFixed(0)}% of runs the money ran out early — usually when the market drops in the first few years. To do even better: keep more money safe, spend a little less, or put part of it into a pension for life.`;
  } else if (mc.successRate >= 0.60) {
    title = `Be careful — your plan works only ${successPct} of the time`;
    body = `That's about a ${(100 - mc.successRate*100).toFixed(0)}% chance of running out of money. What helps: keep more money safe to ride out an early crash, spend a bit less, put part of it into a pension for life, or plan to leave behind less.`;
  } else {
    title = `Risky — your plan works only ${successPct} of the time`;
    body = `Below 60% is dangerous — your plan is relying on the market going right. Consider stopping work a little later, spending noticeably less, or moving more into a pension for life plus safe savings, with a smaller slice in stocks.`;
  }
  interp.className = 'callout callout-' + tone;
  const icons = { success: '✓', info: 'i', warning: '!', danger: '×' };
  interp.setAttribute('role', 'status');
  interp.setAttribute('aria-live', 'polite');
  interp.innerHTML = `<div class="callout-icon" aria-hidden="true">${icons[tone]}</div>
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
      { name: 'How much you take out', data: wrPct, color: 'var(--chart-1)' },
      { name: 'Safe level (4%)', data: safeLine, color: 'var(--warning)' },
    ],
    height: 280,
    valueSuffix: '%',
    ariaLabel: 'Withdrawal rate each year compared with the 4% safe level',
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
      title: "1. Don't overestimate your tax", tone: 'success',
      impact: `save ~${fmtL(taxSavings)}/yr`,
      body: `Many people assume they'll pay 30% tax — but that's only the top rate, not what you actually pay. On ${fmtL(y1Gross)} of interest with no other income, your real tax works out to about <strong>${pct((y1SlabTax/Math.max(1,y1Gross))*100)}</strong> (income up to ₹12 Lakh is tax-free). Set <span class="mono">How your interest is taxed</span> above to <span class="mono">Indian tax rules</span> to see this.`,
    },
    {
      title: `2. Use the ${inp.spouse ? "senior scheme for both of you (₹60 Lakh)" : "senior citizens' scheme (₹30 Lakh)"}`, tone: 'success',
      impact: inp.spouse ? '+1.7% on ₹60 L = ₹1.02 L/yr' : '+1.7% on ₹30 L = ₹51K/yr',
      body: `The government's senior scheme (age 60+) pays <strong>8.2% a year</strong>, is government-backed, and pays you every 3 months. You can put in up to ₹30 Lakh each — ${inp.spouse ? `<strong>₹60 Lakh as a couple</strong> (already counted here).` : 'or ₹60 Lakh as a couple. Turn on <span class="mono">Planning as a couple</span> above to unlock it.'}`,
    },
    {
      title: '3. Add RBI government savings bonds', tone: 'success',
      impact: '+1.55% vs a bank deposit',
      body: `RBI's savings bonds pay <strong>8.05% (Jan–Jun 2026)</strong>, are government-backed, and lock in for 7 years with interest paid twice a year. No upper limit. Parking ₹50 Lakh–1 Crore here earns more than a regular bank deposit.`,
    },
    {
      title: '4. Swap bank deposits for low-tax funds', tone: 'info',
      impact: 'usually much less tax',
      body: `Special low-risk "arbitrage" funds are taxed like stocks, not like interest — so usually far less tax. They earn around 6–7% with deposit-like steadiness. Take an automatic monthly payout, and only the profit part is taxed — often close to nothing in the early years.`,
    },
    {
      title: '5. Move money to safe savings every year', tone: 'warning',
      impact: 'protects against an early crash',
      body: `The "half safe, half stocks" plan waits until the safe side is empty before selling stocks — one big sale at a single moment. If the market is down that day, you sell low. Better: keep 3–5 years of spending on the safe side and top it up a little each year, only when stocks are up. See the luck test below for what this is worth.`,
    },
    {
      title: `6. Use the free ${inp.spouse ? '₹2.5 Lakh' : '₹1.25 Lakh'} tax-free limit every year`,
      tone: inp.taxHarvesting ? 'success' : 'info',
      impact: inp.taxHarvesting
        ? `✓ ON · ${fmtL(yearlyLtcgExemption(inp) * inp.ltcgRate / 100)}/yr saved`
        : `${fmtL(yearlyLtcgExemption(inp) * inp.ltcgRate / 100)}/yr available`,
      body: `${inp.spouse ? '₹2.5 Lakh (₹1.25 Lakh each)' : '₹1.25 Lakh'} of stock profit a year is tax-free. Even if you don't need the cash, sell that much and buy it straight back — you've locked in tax-free profit and lowered your future tax bill. ${inp.taxHarvesting ? '<strong>Already counted here ✓</strong> — turn off <span class="mono">Use the free yearly tax-saver</span> in the Tax section to see the difference.' : '<strong>Turn on <span class="mono">Use the free yearly tax-saver</span> in the Tax section to include it.</strong>'}`,
    },
    {
      title: '7. Split income between you and your spouse', tone: 'success',
      impact: inp.spouse ? `save ~${fmtL(spouseSavings)}/yr` : 'each gets a ₹12 L tax-free limit',
      body: `Two people means two tax-free limits and two senior tax breaks. This works if each spouse holds their own accounts and deposits from their own savings. ${inp.spouse ? 'Already counted here ✓' : 'Turn on <span class="mono">Planning as a couple</span> to include it.'}`,
    },
    {
      title: '8. Push back big costs when you can', tone: 'info',
      impact: `₹1 today = ₹${(Math.pow(1 + inp.equityRate/100, 5) / Math.pow(1 + inp.inflation/100, 5)).toFixed(2)} in 5 yrs`,
      body: `Every rupee you don't spend today keeps growing. Delaying a ₹20 Lakh wedding by 5 years (or trimming it by ₹5 Lakh) lets that money grow for longer — especially valuable in the early years, when an early market drop does the most damage.`,
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
    { bucket: 'Emergency cash · next 1–2 yrs', inst: 'Easy-access savings / liquid funds',          amount: Math.min(2 * inp.monthlyExpense * 12, C * 0.04), ret: '5–6%',       tax: 'Like income' },
    { bucket: 'Steady income · 3–7 yrs',       inst: "Senior citizens' scheme (₹30 L each, max ₹60 L)", amount: Math.min(6000000, C * 0.10),                 ret: '8.2%',       tax: 'Like income' },
    { bucket: 'Steady income · 3–7 yrs',       inst: 'RBI government savings bonds',                amount: Math.min(5000000, C * 0.08),                     ret: '8.05%',      tax: 'Like income' },
    { bucket: 'Steady income · 3–7 yrs',       inst: 'Bank deposits (spread across 4–6 banks)',     amount: Math.min(8000000, C * 0.13),                     ret: '6.5–7.2%',   tax: 'Like income' },
    { bucket: 'Steady & low-tax · 5–10 yrs',   inst: 'Low-risk "arbitrage" funds (auto monthly payout)', amount: Math.min(6600000, C * 0.11),                ret: '6–8%',       tax: 'Like stocks (low)' },
    { bucket: 'Growth · 10+ yrs',              inst: 'Stock-market index / flexi-cap funds',        amount: C - 2400000 - 6000000 - 5000000 - 8000000 - 6600000, ret: '10–12%', tax: 'Like stocks (low)' },
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
    { title: 'Good health insurance is a must', body: 'At 60+, a single hospital stay in a big city can cost ₹10–30 Lakh. Get a family health cover of ₹50 Lakh–1 Crore, plus a top-up plan for the really big bills. The premium runs ₹40,000–80,000 a year at 60 and rises quickly with age. The "Health insurance per year" box above already includes this.' },
    { title: 'Keep a separate emergency fund', body: 'Keep 6–12 months of spending (₹6–12 Lakh) in easy-to-reach cash, outside your main plan. This stops you from having to sell stocks at a bad time for a surprise bill — a roof repair, a car, a family emergency. Even more important if you don\'t have a pension or rent coming in.' },
    { title: 'Tax rules will change', body: 'Today, income up to ₹12 Lakh is tax-free and stock profits are taxed at a low rate. In five years, any of this could change. So spread your money across different types — bank deposits, stocks and funds, the senior scheme — so one rule change can\'t break your whole plan.' },
    { title: 'Bank deposits are insured only up to ₹5 Lakh', body: 'If a bank fails, only ₹5 Lakh per bank per person is guaranteed. So spread large amounts across 4–6 strong banks (SBI, HDFC, ICICI, Axis, Kotak). Don\'t put more than ₹50 Lakh in a small bank, however tempting the interest rate.' },
    { title: 'Sort out nominations and a will', body: 'Add a nominee to every deposit, scheme, and investment account, and write a simple registered will. For a large amount, skipping this can mean years of legal trouble and delay for your family.' },
    { title: 'Spending quietly creeps up', body: 'Your "₹1 Lakh a month" today is a budget, not a promise. Helping children with a down payment, more travel, moving to a nicer home — these all add up. Try the "Spend more" button to see how much cushion you really have.' },
    { title: 'Money decisions get harder after 75', body: 'By 75–80, managing money gets harder. Plan ahead: simple instructions for your spouse or child, someone you trust to handle the accounts, one accountant for taxes, and joint bank accounts. Don\'t leave behind a complicated plan that only you understand.' },
    { title: "Your home isn't counted here", body: 'Most Indian retirees also own their home (often worth ₹2–4 Crore). It gives you a place to live but is hard to turn into cash. If you rent out a property, add that under "Pension or rent". Treat your home as a backup, not money to spend down.' },
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
    title: 'How much you take out each year',
    body: `This is the share of your savings you pull out in a year to pay for your life. It tells you how hard your money is having to work.
      <br><br>A long-trusted rule of thumb: take out about <strong>4% a year</strong> (rising a little with prices) and your money should last 30 years or more.
      <br><br>For India, where prices rise faster, <strong>3.5% is the safer number</strong>. If you're regularly above 5–6%, the plan is on thin ice.`,
  },
  'years-lasted': {
    title: 'Years your money lasts',
    body: `How many years until your total money (safe savings + stock market) hits zero, using your numbers and the plan you've picked.
      <br><br>"50+" means your money survives the whole plan — it stopped because the timeline ran out, not because the money did.`,
  },
  'deplete-age': {
    title: 'Money runs out at age',
    body: `The exact age your money is expected to hit zero, based on your numbers.
      <br><br>"Never" means your money lasts the entire plan (50 years by default). You want this number to be comfortably <strong>past the age you expect to live to</strong>.`,
  },
  'real-nominal': {
    title: "Future rupees vs today's value",
    body: `A rupee in the future buys less than a rupee today, because prices keep rising.
      <br><br>So we show two numbers: the <strong>actual rupees</strong> you'd see in the future, and what that money is <strong>really worth in today's terms</strong>.
      <br><br>Example: ₹10 Crore in 30 years sounds huge, but at 6% yearly price rise it only buys what <strong>₹1.74 Crore</strong> buys today. The "today's value" number is the honest one to plan around.`,
  },
  'first-draw': {
    title: 'When you start dipping into savings',
    body: `At first, the interest you earn on your safe savings is enough to cover your monthly spending. But as prices rise, your spending slowly grows past that interest.
      <br><br>This is the year that happens — the point where you begin spending the savings themselves, not just the interest. After this, your money starts shrinking.`,
  },
  'inputs-overview': {
    title: 'How to use this',
    body: `This tool starts from money you <strong>already have</strong> and shows how long it lasts — it's a drawdown calculator, not a "how much should I save" one.
      <br><br><strong>What it models:</strong> split savings between bank/FD and stocks; live on FD interest first; sell stocks when needed; when the FD side is nearly empty, move half your stocks back into FD and repeat — with Indian tax and inflation, year by year.
      <br><br>Every box can be changed — type a number, drag the slider, or tap one of the buttons at the top to set everything at once.
      <br><br><strong>The starting example shows ₹6 Crore at age 30, spending ₹1 Lakh a month</strong>, with half kept safe and half in the stock market. Change anything to match your own life.
      <br><br>Your numbers are saved on your own device, so they're still here next time you visit.`,
  },
  'strategy-user': {
    title: 'Half safe, half stocks',
    body: `<strong>The classic, simple way to retire.</strong> Keep half your money safe (bank deposits) and put the other half in the stock market (index funds or large mutual funds).
      <br><br><strong>How it works:</strong> live off the interest from your safe savings. When prices rise and that's not enough, start spending the safe savings. When they run out, sell some stocks to top them up, and carry on.
      <br><br><strong>Best for:</strong> people who want one easy rule to follow without constant fiddling. The downside is you pay a bit more tax, and you may have to sell a chunk of stocks all at once — which stings if the market is down that year.`,
  },
  'strategy-improved': {
    title: "Senior citizens' scheme (age 60+)",
    body: `Built for people <strong>aged 60 or older</strong>. The first ₹30 Lakh (or ₹60 Lakh as a couple) goes into the government's <strong>Senior Citizen Savings Scheme at 8.2%</strong> — government-backed, pays you every 3 months, and better than any bank deposit.
      <br><br>The rest is split between safe savings and stocks. Once a year, you sell a small slice of your stock profit tax-free and move it to the safe side.
      <br><br><strong>Why it's better:</strong> a higher, safer return (8.2% vs about 6.5% in a bank), a free yearly tax saving, and you're never forced to sell stocks in a bad year.`,
  },
  'strategy-swp': {
    title: 'Low-tax mutual funds',
    body: `Instead of a bank deposit, keep your "safe" money in special low-risk mutual funds. They behave a lot like a deposit (steady, around 6–7%) but are <strong>taxed like stocks</strong> — which usually means <strong>far less tax</strong> than the interest from a bank deposit.
      <br><br>You then set up an <strong>automatic monthly payout</strong> — the fund sends you a fixed amount each month, and only the profit part is taxed.
      <br><br><strong>Best for:</strong> higher earners with a big amount (₹2 Crore or more). The tax saving really adds up over 20+ years. It takes a little more effort to set up.`,
  },
  'strategy-pureFD': {
    title: 'All in bank deposits (FD)',
    body: `Keep everything in a bank or post-office fixed deposit, earning around 6.5–7.5%. No stock-market risk at all.
      <br><br><strong>The catch:</strong> over 20+ years, rising prices quietly eat away what your money can buy. ₹1 Crore earning ₹6.5 Lakh a year looks fine today — but in 20 years that ₹6.5 Lakh only buys what ₹2 Lakh buys now.
      <br><br>It's useful as a worst-case to compare against. <strong>Almost nobody should keep everything in deposits for a full retirement</strong> — but seeing how it falls short shows why having some money in stocks helps.`,
  },
  'strategy-annuity': {
    title: 'Pension for life',
    body: `Hand your whole amount to an insurance company. In return, they pay you a <strong>fixed amount every month for as long as you live</strong> — guaranteed, with no market risk.
      <br><br><strong>Good:</strong> it can never run out, there's nothing to manage, and it's total peace of mind.
      <br><br><strong>Not so good:</strong> the monthly amount <strong>never rises</strong>, so it buys less and less as prices climb. Your money is locked in (you can't take it back). When you pass away, the money usually stays with the insurer unless you chose a version that returns it (which lowers your monthly payout).
      <br><br><strong>Roughly:</strong> about 6.0% a year if you buy at 60, 7.0% at 70, 7.5% at 80 — the older you are, the higher the payout.`,
  },
  'events': {
    title: 'Big one-off costs',
    body: `Large future expenses you want included in the plan — a child's wedding, college, a big medical bill, a new car, a major trip, and so on.
      <br><br>Enter each amount in <strong>today's money</strong>; the tool adjusts it for future prices automatically.
      <br><br>In the year you set, the tool takes that amount out of your savings (from the safe side first, then from stocks if needed).
      <br><br><strong>Use the ↑ ↓ buttons to reorder the list</strong> — that's just for tidiness. The actual timing comes from the "year" box.`,
  },

  /* ── Per-input help, prefixed "field-" ───────────────────────────────── */
  'field-totalCorpus': {
    title: 'Total savings',
    body: `All the money you have today (or expect to have when you retire) — bank balances, deposits, mutual funds, shares, provident fund (EPF/PPF), pension fund (NPS), plus any money from selling property that you'll invest.
      <br><br>This is the <strong>starting fuel</strong> for your whole plan. Everything below is worked out from this number.
      <br><br><strong>The example uses ₹6 Crore</strong> — roughly what a big-city couple needs for about 25 years at ₹1 Lakh a month. Change it to your actual amount.`,
  },
  'field-fdPercent': {
    title: 'Bank FD vs Stocks Allocation',
    body: `How much of your <strong>total savings</strong> stays in <strong>bank/FD</strong> vs <strong>stocks</strong>. This is the starting point for the whole calculator.
      <br><br><strong>Bank/FD half:</strong> pays your bills from interest first (then from the deposit if needed).<br>
      <strong>Stocks half:</strong> grows in the background and refills the bank side when it runs low.
      <br><br>More in bank = steadier income, but less long-term growth. More in stocks = higher growth, but bigger ups and downs.
      <br><br><strong>Rule of thumb:</strong> "100 minus your age" ≈ % in stocks (at 60 → ~40% stocks / 60% bank; at 30 → ~70% stocks / 30% bank).`,
  },
  'field-maxYears': {
    title: 'Years to plan for',
    body: `How many <strong>years forward</strong> from your age now the tool should run — not the age you plan to retire.
      <br><br><strong>Your age now + this number</strong> is the age you plan through (see the hint next to the slider). Example: age <strong>30</strong> and <strong>50 years</strong> → through age <strong>80</strong>.
      <br><br><strong>50 years</strong> is a sensible default — long enough for early retirement and living well past 90.
      <br><br>Go higher to stress-test a very long life; lower for a quicker check.
      <br><br>"Years your money lasts" can't exceed this — <strong>50+</strong> means your money survived the whole window.`,
  },
  'field-fdRate': {
    title: 'Interest on savings (bank/FD) per year',
    body: `The yearly return on the <strong>bank/FD half</strong> of your split. The calculator spends this interest (after tax) toward your living costs before touching the deposit principal or selling stocks.
      <br><br><strong>May 2026 examples:</strong> SBI 5-year deposit ~6.5% · HDFC ~7.0% · post office 5-year ~7.5% · <strong>senior citizens' scheme 8.2%</strong> (age 60+ only).
      <br><br>This interest is taxed based on the tax setting you choose. For an extra-careful plan, you can enter a lower, after-tax number yourself.`,
  },
  'field-equityRate': {
    title: 'Stock market growth per year',
    body: `How much you expect your <strong>stock-market money</strong> to grow each year, on average — through index funds or large mutual funds.
      <br><br><strong>A reality check:</strong> India's main market index has grown about 11–12% a year over 20 years. Don't put 15%+ — that's wishful thinking and will mislead your plan.
      <br><br><strong>Sensible numbers:</strong> 10–12% normal · 8% cautious · 13% hopeful.
      <br><br>This is also the centre point the "luck test" uses when it tries out random good and bad years.`,
  },
  'field-equityVolatility': {
    title: 'How wildly the market swings',
    body: `<strong>How much stock returns jump around</strong> from one year to the next — the usual size of the ups and downs.
      <br><br><strong>India's market:</strong> about 18–22% a year. So with 12% average growth and 18% swing, most years land somewhere between <strong>−6% and +30%</strong>.
      <br><br>This drives the <strong>"luck test"</strong> — bigger swings mean more bad-luck runs where the plan struggles even though the average looks fine.
      <br><br>Set it to <strong>0</strong> for a smooth, no-surprises projection (every year hits the average exactly).`,
  },
  'field-inflation': {
    title: 'Inflation per year (How fast prices rise)',
    body: `How much your <strong>everyday living costs go up</strong> each year. Prices in India tend to rise faster than in richer countries.
      <br><br><strong>Recent years:</strong> about 4.6–5.0%. <strong>Long-term India average:</strong> roughly 6%.
      <br><br><strong>6% makes for a safer plan.</strong> Use 5% for a hopeful case, or 7% if you're worried about food and fuel price jumps. This does <em>not</em> cover medical costs — those have their own box below.`,
  },
  'field-healthInflation': {
    title: 'Medical inflation per year (How fast medical costs rise)',
    body: `How much <strong>medical costs go up</strong> each year — and in India they rise much faster than everyday prices.
      <br><br><strong>Medical costs</strong> have climbed 12–14% a year for over 15 years — hospital bills, surgery, intensive care, and insurance premiums. This is one of the biggest threats to a retirement plan.
      <br><br><strong>Used for:</strong> the rising cost of your health insurance and any medical one-off costs.<br>
      <strong>Don't</strong> set this the same as everyday prices — that's the most common mistake people make.`,
  },
  'field-monthlyExpense': {
    title: 'Monthly spending',
    body: `What you typically spend in a month on living — rent or loan EMI, groceries, bills, travel, household help, eating out, kids, subscriptions. <strong>In today's money.</strong>
      <br><br><strong>Tip:</strong> look at your last 6 months of bank and card statements and take the average. Add about 10% for surprises (gifts, repairs).
      <br><br>The tool grows this every year with rising prices, and tweaks it a little in older age. Health insurance and big one-off costs are counted separately.`,
  },
  'field-healthInsuranceAnnual': {
    title: 'Health insurance per year',
    body: `Your yearly health-insurance premium for the family, plus a little spare for costs insurance won't cover. <strong>In today's money.</strong>
      <br><br><strong>Roughly:</strong> ₹50,000–₹70,000 a year for a ₹50 Lakh–₹1 Crore family cover at age 50. <strong>It jumps sharply after 65</strong> (₹1.5 Lakh+ is common).
      <br><br>This grows every year at the faster <strong>medical-cost</strong> rate above, not the everyday-prices rate. This one line is often the difference between a plan that lasts past 80 and one that doesn't.`,
  },
  'field-pensionAnnual': {
    title: 'Pension or rent you receive',
    body: `Steady income from <strong>outside your savings</strong> — a government pension, NPS pension, rent from a property, a family-business payout, and so on. <strong>In today's money, per year.</strong>
      <br><br><strong>"Grows with prices" switch:</strong> turn it on for income that rises over time (like rent). Turn it off for income that stays fixed forever (like most insurance pensions).
      <br><br>This income is added in each year and <strong>directly lowers</strong> how much you need to take from your savings.`,
  },
  'field-otherIncome': {
    title: 'Any other income',
    body: `Other income that isn't interest — freelance or consulting work, board fees, royalties, business payouts. <strong>In today's money, per year.</strong>
      <br><br>It's treated as <strong>fixed (no yearly rise)</strong> and added to your interest when working out your tax for the year. Handy for "what if I keep earning ₹X for 5 more years after I retire" checks.
      <br><br>If you expect this income to grow over time, use the "Pension or rent" box with the "grows with prices" switch on instead.`,
  },
  'field-lifestyleMid': {
    title: 'Spending at ages 65–75',
    body: `How your spending changes between <strong>65 and 75</strong> compared with your normal monthly spending.
      <br><br><strong>0.95</strong> means about 5% less (kids settled, less travel, simpler routine).
      <br><br><strong>Change it to:</strong><br>
      • <strong>1.0</strong> — no change<br>
      • <strong>0.85</strong> — a leaner phase<br>
      • <strong>1.1</strong> — more travel and hobbies
      <br><br>This only affects your everyday spending. Health insurance and one-off costs are counted separately.`,
  },
  'field-lifestyleOld': {
    title: 'Spending after age 75',
    body: `How your spending changes after <strong>75</strong> — often it <em>rises</em> again because of help at home, nursing, and care that insurance doesn't cover.
      <br><br><strong>1.15</strong> means about 15% more than normal.
      <br><br><strong>Change it to:</strong><br>
      • <strong>1.30+</strong> — full assisted-living lifestyle<br>
      • <strong>1.00</strong> — a simple stay-at-home plan<br>
      • <strong>0.85</strong> — moving in with family
      <br><br>Rising health-insurance costs and medical one-off costs are counted separately from this.`,
  },
  'field-taxMode': {
    title: 'How your interest is taxed',
    body: `How the interest from your safe savings is taxed each year.
      <br><br><strong>Indian tax rules:</strong> your interest is added to your income and taxed at India's current rates. Thanks to a rebate, income up to <strong>₹12 Lakh a year pays no income tax</strong>. People aged 60+ get an extra ₹50,000 tax-free on interest.
      <br><br><strong>Simple flat rate:</strong> just use one fixed percentage you choose (handy for a quick check, or if you live outside India).`,
  },
  'field-flatTaxRate': {
    title: 'Flat tax rate',
    body: `A single tax percentage on your interest, used <strong>only</strong> when you pick "Simple flat rate".
      <br><br><strong>Realistic choices:</strong><br>
      • <strong>20–30%</strong> if you have several sources of income in retirement<br>
      • <strong>10–15%</strong> if interest is your only income<br>
      • <strong>0%</strong> to ignore tax completely (a before-tax check)
      <br><br>This skips all the Indian tax breaks — use it only for quick checks, not for serious planning.`,
  },
  'field-isSenior': {
    title: 'Age 60 or older',
    body: `Are you <strong>60 or older</strong>? Turning this on adds two tax benefits for seniors:
      <br><br>1) The <strong>first ₹50,000 a year</strong> of bank interest becomes tax-free.<br>
      2) You can use the <strong>senior citizens' scheme at 8.2%</strong> (vs about 6.5% in a normal deposit) — used by that plan.
      <br><br>Turn it on if you're 60+ <em>today</em>. If you're planning for the future, just set your age in "Your age now" instead — the tool checks your age each year for you.`,
  },
  'field-spouse': {
    title: 'Planning as a couple',
    body: `Are you planning <strong>as a couple</strong>, both retiring together?
      <br><br><strong>What turning this on changes:</strong><br>
      • <strong>Senior citizens' scheme:</strong> the limit doubles from ₹30 Lakh to <strong>₹60 Lakh</strong> (one slot each).<br>
      • <strong>Tax:</strong> income is split across two people, so each gets their own tax-free limits. The tax-free limit on stock profit doubles to ₹2.5 Lakh a year.
      <br><br><strong>What stays the same:</strong><br>
      • Your savings stay <strong>one combined pot</strong> — not split into two.<br>
      • Your monthly spending stays your <strong>whole household</strong> total — not halved.<br>
      • For the full couple benefit, also turn on "Age 60 or older".`,
  },
  'field-taxHarvesting': {
    title: 'The free yearly tax-saver',
    body: `In India, the <strong>first ₹1.25 Lakh of stock-market profit each year is tax-free</strong> (₹2.5 Lakh as a couple) — but only if you actually "use" it that year.
      <br><br><strong>The trick:</strong> each year, sell just enough stock to use up that free limit, then <strong>buy it straight back</strong>. You pay no tax now, and you quietly lower the tax you'll owe when you finally sell for real.
      <br><br><strong>Why it helps:</strong> that free limit resets every year — use it or lose it. If you never do this, all your profit piles up into one big tax bill years later.
      <br><br><strong>What the tool does when this is on:</strong> at the end of each year it sells a small slice of stock to use the free limit, then re-buys it right away. Your investments stay the same size — <strong>no tax, no risk, no real money moves.</strong>
      <br><br><strong>The payoff:</strong> over 20–30 years this can save several lakhs in tax. There's a tiny fee each time, but it's trivial next to the tax saved. That's why it's on by default — turn it off to see the difference.`,
  },
  'field-startingAge': {
    title: 'Your age now',
    body: `Your age at the <strong>start of the plan</strong> — your age today, not the age you plan to retire.
      <br><br>It's used to:<br>
      • label the ages on every chart<br>
      • know when the senior tax breaks and senior scheme begin (at 60)<br>
      • adjust your spending in older age (the 65–75 and 75+ settings)
      <br><br><strong>Already retired?</strong> Put your current age.<br>
      <strong>Planning ahead?</strong> Put your current age, and read the chart from the year you actually retire.`,
  },
  'field-bequestGoal': {
    title: 'Money to leave for family',
    body: `How much you'd like to <strong>leave behind</strong> at the end of the plan — for children, family, or charity. <strong>In today's money.</strong>
      <br><br>This isn't a hard rule — the tool simply shows whether your plan leaves at least this much (in today's value) at the end.
      <br><br><strong>0</strong> means "spend it all yourself, nothing to leave behind". Set a number if you want to plan for a specific gift.`,
  },
};

let openInfoBtn = null;

function showInfoPopover(btn) {
  const key = btn.dataset.info;
  const content = INFO_CONTENT[key];
  const popover = document.getElementById('infoPopover');
  if (!popover || !content) return;
  popover.innerHTML = `
    <div class="info-popover-title" id="infoPopoverTitle">
      <span>${content.title}</span>
      <button type="button" class="info-popover-close" aria-label="Close help">×</button>
    </div>
    <div class="info-popover-body">${content.body}</div>
  `;
  popover.classList.add('show');
  popover.setAttribute('aria-hidden', 'false');
  popover.setAttribute('aria-labelledby', 'infoPopoverTitle');
  positionPopover(btn, popover);
  openInfoBtn = btn;
  const closeBtn = popover.querySelector('.info-popover-close');
  closeBtn.addEventListener('click', hideInfoPopover);
  closeBtn.focus();
}

function hideInfoPopover() {
  const popover = document.getElementById('infoPopover');
  const returnFocus = openInfoBtn;
  if (!popover) return;
  popover.classList.remove('show');
  popover.setAttribute('aria-hidden', 'true');
  popover.removeAttribute('aria-labelledby');
  openInfoBtn = null;
  if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus();
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
/** Wire range sliders and number fields to visible labels; disable password-manager heuristics. */
function setupInputA11y() {
  document.querySelectorAll('.input-field').forEach(field => {
    const labelText = field.querySelector('.input-label-text');
    const range = field.querySelector('input[type="range"]');
    const num = field.querySelector('input[type="number"]');
    const text = labelText
      ? labelText.textContent.replace(/\s*ⓘ\s*/g, ' ').replace(/\s+/g, ' ').trim()
      : '';
    if (range && text) range.setAttribute('aria-label', text);
    [range, num].forEach(el => {
      if (!el) return;
      el.setAttribute('autocomplete', 'off');
      if (num && !num.getAttribute('name') && num.id) num.setAttribute('name', num.id);
    });
  });
  const pensionInflated = document.getElementById('pensionInflated');
  if (pensionInflated) {
    pensionInflated.setAttribute('aria-label', 'Pension or rent grows with inflation');
    pensionInflated.setAttribute('name', 'pensionInflated');
  }
}

function setupPlanSplitRange() {
  const wrap = document.getElementById('planSplitRange');
  const range = document.getElementById('fdPercentRange');
  if (!wrap || !range) return;
  const startDrag = () => wrap.classList.add('is-dragging');
  const endDrag = () => wrap.classList.remove('is-dragging');
  range.addEventListener('pointerdown', startDrag);
  range.addEventListener('pointerup', endDrag);
  range.addEventListener('pointercancel', endDrag);
  range.addEventListener('lostpointercapture', endDrag);
  window.addEventListener('pointerup', endDrag);
}

function setupEvents() {
  setupInputA11y();
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
      if (k === 'fdPercent' || k === 'totalCorpus') renderMethodSplit(state.inputs);
      scheduleUpdate();
      markPresetActive(null);
    }
    num.addEventListener('input', e => update(e.target.value));
    range.addEventListener('input', e => update(e.target.value));
  });

  setupPlanSplitRange();

  // Boolean toggles
  ['isSenior', 'spouse', 'pensionInflated', 'taxHarvesting'].forEach(k => {
    const el = document.getElementById(k);
    if (!el) return;
    el.addEventListener('change', e => {
      state.inputs[k] = e.target.checked;
      scheduleUpdate();
      markPresetActive(null);
    });
  });

  // Tax mode switch — CSS swaps the panel via :checked; JS just updates state
  document.querySelectorAll('input[name="taxMode"]').forEach(r => {
    r.addEventListener('change', () => {
      state.inputs.taxMode = r.checked ? r.value : state.inputs.taxMode;
      scheduleUpdate();
    });
  });

  document.querySelectorAll('.method-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const pct = parseInt(btn.dataset.fdPct, 10);
      if (!Number.isFinite(pct)) return;
      state.inputs.fdPercent = pct;
      const num = document.getElementById('fdPercent');
      const range = document.getElementById('fdPercentRange');
      if (num) num.value = pct;
      if (range) range.value = pct;
      renderMethodSplit(state.inputs);
      scheduleUpdate();
      markPresetActive(null);
    });
  });

  // Scenario presets (top bar only — not plan-split chips)
  document.querySelectorAll('.preset-chip[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset;
      if (!PRESETS[preset]) return;
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
      activateStrategyTab(tab);
    });
    tab.addEventListener('keydown', (e) => {
      const tabs = [...document.querySelectorAll('#strategyTabs .tab')];
      const i = tabs.indexOf(tab);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        activateStrategyTab(tabs[(i + 1) % tabs.length]);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        activateStrategyTab(tabs[(i - 1 + tabs.length) % tabs.length]);
      }
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

  // Simple / Advanced mode — header segmented toggle + the in-context reveal link
  document.querySelectorAll('#modeToggle .mode-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode, { animate: true, origin: btn }));
  });
  const advReveal = document.getElementById('advReveal');
  if (advReveal) advReveal.addEventListener('click', () => setMode('advanced', { animate: true, origin: advReveal }));

  // Export XLSX (lazy-loads SheetJS + xlsx-export module on first click)
  document.getElementById('exportBtn').addEventListener('click', exportXLSX);

  // Share — copy/share a link that restores the current inputs
  const shareBtn = document.getElementById('shareBtn');
  if (shareBtn) shareBtn.addEventListener('click', shareInputs);

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

function activateStrategyTab(tab) {
  if (!tab) return;
  document.querySelectorAll('#strategyTabs .tab').forEach(t => {
    const on = t === tab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
    t.tabIndex = on ? 0 : -1;
  });
  const panel = document.getElementById('trajectory-panel');
  if (panel) panel.setAttribute('aria-labelledby', tab.id);
  tab.focus();
  state.activeStrategy = tab.dataset.strategy;
  const sim = ({ user: simulateUserStrategy, improved: simulateImproved, swp: simulateSWP, pureFD: simulatePureFD, annuity: simulateAnnuity }[state.activeStrategy])();
  renderTrajectory(sim);
}

function markPresetActive(preset) {
  document.querySelectorAll('.preset-chip[data-preset]').forEach(c => {
    const on = c.dataset.preset === preset;
    c.classList.toggle('active', on);
    c.setAttribute('aria-pressed', on ? 'true' : 'false');
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

/* ════════════════════════════════════════════════════════════════════════
   SIMPLE / ADVANCED MODE
   Pure presentation: every input always lives in state.inputs (and stays in the
   DOM), so the engine runs identically in both modes — Simple just collapses the
   advanced groups. The choice persists in localStorage and travels in the share
   link, and is kept separate from inputs so Reset / presets never disturb it.
   ════════════════════════════════════════════════════════════════════════ */
const MODE_KEY = 'retire-mode';
const MODE_PARAM = 'm';
const MODE_DISCOVERED_KEY = 'retire-mode-discovered';

function loadSavedMode() {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return (m === 'simple' || m === 'advanced') ? m : null;
  } catch (e) { return null; }
}

/** Has the user ever opened Advanced? Once true, we stop nudging for good. */
function advancedDiscovered() {
  try { return localStorage.getItem(MODE_DISCOVERED_KEY) === '1'; } catch (e) { return false; }
}

/** Show the breathing nudge only while in Simple AND never tried Advanced. */
function updateModeNudge() {
  const show = state.mode === 'simple' && !advancedDiscovered();
  const toggle = document.getElementById('modeToggle');
  if (toggle) toggle.classList.toggle('mode-toggle--nudge', show);
  const reveal = document.getElementById('advReveal');
  if (reveal) reveal.classList.toggle('adv-reveal--nudge', show);
}

/** Reflect a mode in the DOM: html class (drives the CSS collapse of inputs +
 *  output sections), the sliding-thumb position, inert on the hidden inputs
 *  (keeps them out of tab order / a11y tree), the toggle button UI, and nudge. */
function applyMode(mode) {
  document.documentElement.classList.toggle('mode-advanced', mode === 'advanced');
  const toggle = document.getElementById('modeToggle');
  if (toggle) toggle.dataset.active = mode;
  const adv = document.getElementById('advancedInputs');
  if (adv) {
    if (mode === 'advanced') adv.removeAttribute('inert');
    else adv.setAttribute('inert', '');
  }
  document.querySelectorAll('#modeToggle .mode-toggle-btn').forEach(btn => {
    const on = btn.dataset.mode === mode;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  updateModeNudge();
  const reveal = document.getElementById('advReveal');
  if (reveal) reveal.setAttribute('aria-expanded', mode === 'advanced' ? 'true' : 'false');
}

function setMode(mode, opts = {}) {
  if (mode !== 'simple' && mode !== 'advanced') return;
  const prev = state.mode;
  state.mode = mode;
  if (mode === 'advanced') {
    try { localStorage.setItem(MODE_DISCOVERED_KEY, '1'); } catch (e) {}  // stop nudging forever
  }
  applyMode(mode);
  try { localStorage.setItem(MODE_KEY, mode); } catch (e) {}
  if (mode === 'advanced' && prev !== 'advanced') {
    // Sections hidden in Simple rendered their charts at the min-width floor;
    // now that they're visible, re-render so each chart measures its real width.
    renderAll();
    if (opts.animate) fireConfetti(opts.origin);
  }
}

/* Lightweight, dependency-free confetti burst. Respects reduced-motion. */
let _confettiActive = false;
function fireConfetti(origin) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (_confettiActive) return;
  _confettiActive = true;

  const canvas = document.createElement('canvas');
  canvas.className = 'confetti-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(innerWidth * dpr);
  canvas.height = Math.floor(innerHeight * dpr);
  canvas.style.width = innerWidth + 'px';
  canvas.style.height = innerHeight + 'px';
  document.body.appendChild(canvas);

  const colors = ['#6366f1', '#059669', '#d97706', '#dc2626', '#0284c7', '#a855f7'];
  let ox = innerWidth / 2, oy = innerHeight * 0.18;
  if (origin && origin.getBoundingClientRect) {
    const r = origin.getBoundingClientRect();
    ox = r.left + r.width / 2;
    oy = r.bottom + 6;
  }
  const parts = [];
  for (let i = 0; i < 150; i++) {
    const ang = (-Math.PI / 2) + (Math.random() - 0.5) * Math.PI * 1.1;  // mostly upward, fanned out
    const spd = 7 + Math.random() * 9;
    parts.push({
      x: ox + (Math.random() - 0.5) * 40,
      y: oy + (Math.random() - 0.5) * 20,
      vx: Math.cos(ang) * spd,
      vy: Math.sin(ang) * spd,
      g: 0.24 + Math.random() * 0.12,
      w: 6 + Math.random() * 7, h: 9 + Math.random() * 8,
      rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4,
      color: colors[(Math.random() * colors.length) | 0],
      life: 0, ttl: 110 + Math.random() * 50,
    });
  }
  let frame = 0;
  function tick() {
    frame++;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(dpr, dpr);
    let alive = false;
    for (const p of parts) {
      if (p.life > p.ttl) continue;
      alive = true;
      p.life++;
      p.vy += p.g; p.vx *= 0.99;
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - p.life / p.ttl);
      ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    ctx.restore();
    if (alive && frame < 300) requestAnimationFrame(tick);
    else { canvas.remove(); _confettiActive = false; }
  }
  requestAnimationFrame(tick);
}

/* ─── Excel export ─── */
/**
 * Multi-sheet XLSX export with live formulas. The workbook contains an
 * editable Inputs tab — when the user changes any value inside Excel /
 * Google Sheets, every projection sheet recalculates automatically (no
 * regeneration from this page needed).
 *
 * SheetJS Community Edition (~930 KB) and the xlsx-export module are
 * lazy-loaded only on first click to keep initial page-weight unchanged.
 */
const XLSX_VENDOR_URL = 'assets/vendor/xlsx.full.min.js';
const XLSX_EXPORT_URL = 'assets/js/xlsx-export.js';
let _xlsxBundlePromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === '1') return resolve();
      existing.addEventListener('load',  () => resolve());
      existing.addEventListener('error', reject);
      return;
    }
    const sc = document.createElement('script');
    sc.src = src;
    sc.async = true;
    sc.addEventListener('load',  () => { sc.dataset.loaded = '1'; resolve(); });
    sc.addEventListener('error', () => reject(new Error('Failed to load ' + src)));
    document.head.appendChild(sc);
  });
}

function loadXlsxBundle() {
  if (_xlsxBundlePromise) return _xlsxBundlePromise;
  _xlsxBundlePromise = loadScript(XLSX_VENDOR_URL)
    .then(() => loadScript(XLSX_EXPORT_URL))
    .then(() => {
      if (!window.XLSX || !window.RetirementXLSX) {
        throw new Error('Excel export modules failed to initialise.');
      }
    });
  return _xlsxBundlePromise;
}

async function exportXLSX() {
  const btn = document.getElementById('exportBtn');
  const originalHTML = btn.innerHTML;
  const labelSpan = btn.querySelector('span');
  const originalLabel = labelSpan ? labelSpan.textContent : null;
  btn.disabled = true;
  if (labelSpan) labelSpan.textContent = 'Building…';
  try {
    await loadXlsxBundle();
    const wb = window.RetirementXLSX.build(state.inputs);
    const corpusCr  = (state.inputs.totalCorpus / 1e7).toFixed(1);
    const monthlyK  = Math.round(state.inputs.monthlyExpense / 1000);
    const filename  = `retirement-${corpusCr}cr-${monthlyK}k.xlsx`;
    window.XLSX.writeFile(wb, filename, { bookType: 'xlsx', cellStyles: true });
  } catch (err) {
    console.error('XLSX export failed', err);
    alert('Sorry — Excel export failed. ' + (err && err.message ? err.message : ''));
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHTML;
    if (labelSpan && originalLabel !== null) labelSpan.textContent = originalLabel;
  }
}

/* ════════════════════════════════════════════════════════════════════════
   SHARE — encode every input into a URL; opening it restores them
   ════════════════════════════════════════════════════════════════════════ */
const SHARE_PARAM = 's';

/**
 * Accept only known keys from DEFAULTS, coerce types, clamp values, and
 * validate the events array. Anything unknown/garbage is dropped so a
 * malformed or hostile link can never break the calculator.
 */
function sanitizeInputs(obj) {
  if (!obj || typeof obj !== 'object') return { ...DEFAULTS };
  const clean = {};
  Object.keys(DEFAULTS).forEach(k => {
    if (!(k in obj)) return;
    const def = DEFAULTS[k];
    const val = obj[k];
    if (k === 'events') {
      if (Array.isArray(val)) {
        clean.events = val.slice(0, 50).map((e, i) => ({
          id: Number.isFinite(+(e && e.id)) ? +e.id : i + 1,
          year: Math.max(1, Math.round(+(e && e.year)) || 1),
          amount: Math.max(0, +(e && e.amount) || 0),
          label: e && typeof e.label === 'string' ? e.label.slice(0, 120) : '',
        }));
      }
    } else if (k === 'taxMode') {
      if (val === 'slab' || val === 'flat') clean.taxMode = val;
    } else if (typeof def === 'boolean') {
      clean[k] = !!val;
    } else if (typeof def === 'number') {
      const n = +val;
      if (Number.isFinite(n)) clean[k] = n;
    }
  });
  return { ...DEFAULTS, ...clean };
}

/** state.inputs -> URL-safe base64 (UTF-8 safe, no padding). */
function encodeInputs(inputs) {
  const json = JSON.stringify(inputs);
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** URL-safe base64 -> sanitized inputs object (throws on malformed input). */
function decodeInputs(str) {
  let b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  const json = new TextDecoder().decode(bytes);
  return sanitizeInputs(JSON.parse(json));
}

function buildShareURL() {
  return location.origin + location.pathname
    + '?' + SHARE_PARAM + '=' + encodeInputs(state.inputs)
    + '&' + MODE_PARAM + '=' + state.mode;
}

/** Transient bottom-center confirmation toast (reused element, auto-dismisses). */
let _toastTimer = null;
function showToast(message) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.innerHTML = '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg><span class="toast-msg"></span>';
    document.body.appendChild(toast);
  }
  toast.querySelector('.toast-msg').textContent = message;
  void toast.offsetWidth;  // restart the enter animation if re-triggered quickly
  toast.classList.add('toast-show');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    toast.classList.remove('toast-show');
    _toastTimer = null;
  }, 2600);
}

/** Copy a share link to the clipboard and confirm with a toast. */
async function shareInputs() {
  const url = buildShareURL();
  try {
    await navigator.clipboard.writeText(url);
    showToast('Link Copied For Sharing');
  } catch (err) {
    // Older / insecure (non-HTTPS) contexts have no clipboard API — fall back to a manual copy prompt
    window.prompt('Copy this link to share your inputs:', url);
  }
}

/**
 * On load: if ?s= is present and valid, apply it (overriding any saved
 * localStorage state) and persist it, then strip the param so the canonical
 * URL stays clean and subsequent edits/refreshes behave normally.
 */
function applySharedStateFromURL() {
  let params;
  try { params = new URLSearchParams(location.search); } catch (e) { return; }
  const raw = params.get(SHARE_PARAM);
  const sharedMode = params.get(MODE_PARAM);
  let applied = false;
  if (raw) {
    try { state.inputs = decodeInputs(raw); saveState(); applied = true; }
    catch (e) { /* malformed inputs — keep saved/default state */ }
  }
  if (sharedMode === 'simple' || sharedMode === 'advanced') {
    state.mode = sharedMode;
    try { localStorage.setItem(MODE_KEY, sharedMode); } catch (e) {}
    applied = true;
  }
  // Strip the params so the canonical URL stays clean and refreshes behave normally
  if (applied) {
    try { history.replaceState({}, '', location.pathname + location.hash); } catch (e) {}
  }
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
   "SHOW MORE" PROGRESSIVE DISCLOSURE
   Long static lists (glossary, FAQ) keep every item in the HTML so search
   engines and AI answer engines index the full content. We collapse them in
   the browser ONLY (a pure JS enhancement) and reveal the rest on click with a
   smooth height + fade animation. There is no "show less" by design.
   ════════════════════════════════════════════════════════════════════════ */
function setupShowMore() {
  document.querySelectorAll('[data-show-more]').forEach(initShowMore);
}

/** Smooth collapse for plan-split <details> when CSS allow-discrete is unavailable. */
function setupPlanSplitDetails() {
  const cssCollapse =
    CSS.supports('transition-behavior', 'allow-discrete')
    && CSS.supports('interpolate-size', 'allow-keywords');
  if (cssCollapse) return;

  document.querySelectorAll('.plan-split-details').forEach(details => {
    const summary = details.querySelector('summary');
    const panel = details.querySelector('.plan-split-example');
    if (!summary || !panel) return;

    summary.addEventListener('click', (e) => {
      if (!details.open) return;
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

      e.preventDefault();
      const startH = panel.scrollHeight;
      panel.style.overflow = 'hidden';
      panel.style.height = startH + 'px';
      void panel.offsetHeight;
      panel.style.transition = 'height 0.35s ease, opacity 0.2s ease';
      panel.style.opacity = '0';
      panel.style.height = '0';

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        details.open = false;
        panel.style.transition = '';
        panel.style.height = '';
        panel.style.overflow = '';
        panel.style.opacity = '';
      };
      panel.addEventListener('transitionend', (ev) => {
        if (ev.propertyName === 'height') finish();
      });
      setTimeout(finish, 450);
    });
  });
}

function initShowMore(wrap) {
  const list = document.querySelector(wrap.dataset.target || '');
  const itemSel = wrap.dataset.item;
  if (!list || !itemSel) return;
  const items = Array.from(list.querySelectorAll(itemSel));
  const visible = parseInt(wrap.dataset.visible, 10) || 8;
  if (items.length <= visible) return; // short enough already — leave fully expanded

  const hiddenItems = items.slice(visible);
  hiddenItems.forEach(el => el.classList.add('show-more-hidden'));

  const label = wrap.querySelector('.show-more-btn-label');
  if (label && wrap.dataset.label) label.textContent = wrap.dataset.label.replace('{n}', items.length);

  wrap.hidden = false; // reveal the control now that JS has collapsed the list

  const btn = wrap.querySelector('.show-more-btn');
  if (btn) btn.addEventListener('click', () => expandShowMore(wrap, list, hiddenItems, btn), { once: true });
}

function expandShowMore(wrap, list, hiddenItems, btn) {
  if (btn) btn.setAttribute('aria-expanded', 'true');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reduce) {
    hiddenItems.forEach(el => el.classList.remove('show-more-hidden'));
    dismissShowMore(wrap);
    return;
  }

  // Grow the container from its collapsed height to its full height while the
  // freshly revealed items fade/slide in (staggered).
  const startH = list.offsetHeight;
  hiddenItems.forEach((el, i) => {
    el.classList.remove('show-more-hidden');
    el.style.setProperty('--sm-i', String(i));
    el.classList.add('show-more-revealing');
    el.addEventListener('animationend', () => {
      el.classList.remove('show-more-revealing');
      el.style.removeProperty('--sm-i');
    }, { once: true });
  });
  const endH = list.scrollHeight;

  list.style.overflow = 'hidden';
  list.style.height = startH + 'px';
  void list.offsetHeight; // force reflow so the next change animates
  list.style.transition = 'height .5s cubic-bezier(.22, .61, .36, 1)';
  list.style.height = endH + 'px';

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    list.style.transition = '';
    list.style.height = '';
    list.style.overflow = '';
  };
  list.addEventListener('transitionend', function te(e) {
    if (e.target !== list || e.propertyName !== 'height') return;
    list.removeEventListener('transitionend', te);
    cleanup();
  });
  setTimeout(cleanup, 700); // safety net if transitionend never fires

  dismissShowMore(wrap);
}

function dismissShowMore(wrap) {
  const finish = () => { wrap.hidden = true; wrap.classList.remove('show-more--done'); };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { finish(); return; }
  wrap.classList.add('show-more--done');
  let done = false;
  const end = () => { if (done) return; done = true; finish(); };
  wrap.addEventListener('transitionend', function te(e) {
    if (e.target !== wrap || e.propertyName !== 'opacity') return;
    wrap.removeEventListener('transitionend', te);
    end();
  });
  setTimeout(end, 500);
}

/* ════════════════════════════════════════════════════════════════════════
   LIVE RESULT DOCK — keep the headline answer pinned while editing inputs
   Visible only while the user is working in the inputs and the real result
   section is still off-screen below; tapping it jumps to the full result.
   ════════════════════════════════════════════════════════════════════════ */
let dockVisible = false;
let dockRaf = 0;

function updateResultDock() {
  dockRaf = 0;
  const dock = document.getElementById('resultDock');
  const calc = document.getElementById('calculator');
  // Anchor on the actual headline stat cards (not the section heading) so the
  // dock stays up until the real numbers are on screen — important in Simple
  // mode, where the result sits right below a short list of inputs.
  const answer = document.querySelector('#live-result .hero-stats') || document.getElementById('live-result');
  if (!dock || !calc || !answer) return;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const calcTop = calc.getBoundingClientRect().top;
  const answerTop = answer.getBoundingClientRect().top;
  // Show once the calculator has scrolled into the upper part of the viewport
  // (you're editing inputs) AND the headline numbers haven't yet reached the
  // lower portion of the screen (the real answer is still off-screen below).
  const show = calcTop < vh * 0.55 && answerTop > vh * 0.85;
  if (show === dockVisible) return;
  dockVisible = show;
  dock.classList.toggle('is-visible', show);
  dock.setAttribute('aria-hidden', show ? 'false' : 'true');
  if (show) dock.removeAttribute('tabindex');
  else dock.setAttribute('tabindex', '-1');
}

function requestDockUpdate() {
  if (dockRaf) return;
  dockRaf = requestAnimationFrame(updateResultDock);
}

function setupResultDock() {
  const dock = document.getElementById('resultDock');
  if (!dock) return;
  dock.addEventListener('click', () => {
    const result = document.getElementById('live-result');
    if (!result) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    result.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  });
  window.addEventListener('scroll', requestDockUpdate, { passive: true });
  window.addEventListener('resize', requestDockUpdate);
  updateResultDock();
}

/* ════════════════════════════════════════════════════════════════════════
   BOOT
   ════════════════════════════════════════════════════════════════════════ */
function boot() {
  // Skip the Simple/Advanced reveal animation during the initial paint
  document.documentElement.classList.add('mode-preload');
  // Theme init
  const savedTheme = (() => { try { return localStorage.getItem('retire-theme'); } catch (e) { return null; } })();
  setTheme(savedTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  refreshChartColors();
  // Mode init from localStorage (a shared link can still override it below)
  state.mode = loadSavedMode() || 'simple';
  // Wire events
  setupEvents();
  setupInfoButtons();
  setupFAQ();
  setupShowMore();
  setupPlanSplitDetails();
  setupResultDock();
  // Strategy tabs: roving tabindex on first paint
  document.querySelectorAll('#strategyTabs .tab').forEach(t => {
    t.tabIndex = t.classList.contains('active') ? 0 : -1;
  });
  // Dynamic year in brand subtitle
  const yearEl = document.getElementById('brandYear');
  if (yearEl) yearEl.textContent = new Date().getFullYear();
  // Apply shared inputs + mode from URL (?s=, ?m=) before first render; overrides localStorage
  applySharedStateFromURL();
  // If the user is already in Advanced (returning user or shared link), they've
  // effectively discovered it — don't nudge them later when they visit Simple.
  if (state.mode === 'advanced') { try { localStorage.setItem(MODE_DISCOVERED_KEY, '1'); } catch (e) {} }
  // Reflect the resolved mode in the DOM (toggle UI, thumb, inert, collapse, nudge)
  applyMode(state.mode);
  // Render UI
  renderEventsList();
  markPresetActive('base');
  renderAll();
  // Re-enable the reveal animation once the first frame has painted
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.documentElement.classList.remove('mode-preload');
  }));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
