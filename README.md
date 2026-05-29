# Will My Money Last? — Free India Retirement Calculator

A free retirement-income planner for India. Type your savings, monthly expense, and age, and see year-by-year exactly when your money runs out — under FY 2025-26 New Regime tax, 6% inflation, 12% healthcare inflation, and a 500-run Monte Carlo on equity volatility. Five drawdown strategies are compared side-by-side: Pure FD, 50/50 FD+Equity, SCSS-led, Arbitrage + SWP, and Lifetime Annuity.

Live: **https://retirement.techdevix.com/**

- Single self-contained HTML file (~250 KB), works offline once saved
- No signup, no payment — retirement calculations run client-side
- Inputs persist in `localStorage` on the user's device only

## Features

- Year-by-year corpus simulation up to **60 years**
- **Five strategies** compared in one click — Pure FD, 50/50 FD+Equity, SCSS-led, Arbitrage + SWP, Lifetime Annuity
- **Monte Carlo** probability of success (500 runs, configurable volatility, normal distribution clamped at -55%)
- **FY 2025-26 New Regime tax** — Section 87A rebate (₹12 L), marginal relief, surcharge 10–25%, 4% cess
- **Section 80TTB** ₹50K senior-citizen interest deduction
- **LTCG** 12.5% with ₹1.25 L annual exemption (Finance Act 2024)
- **Spouse tax-splitting** — each filer's own 87A and 80TTB; doubles the SCSS ceiling
- Separate **healthcare inflation** rate (default 12%)
- **Lifestyle expense bands** by age (65–75, 75+)
- **One-off life events** — weddings, education, medical, travel, car (↑ ↓ to reorder)
- **Pension and rental income**, optionally inflation-indexed
- **Bequest / legacy** goal tracking
- **Withdrawal-rate** chart against the 4% safe-rate baseline
- **CSV export** of the full year-by-year ledger
- Light and dark themes; fully responsive
- **PWA** / Add-to-Home-Screen support

## Default rates and tax constants (May 2026)

| Item | Default | Source |
|---|---|---|
| FD rate | 6.5% p.a. | Stable Money / Business Standard, May 2026 |
| SCSS rate (Q1 FY 25-26) | 8.2% p.a. | India Post |
| RBI FRSB (Jan–Jun 2026) | 8.05% p.a. | Reserve Bank of India |
| Equity expected return | 12% p.a. | Nifty 50 ~20-yr CAGR |
| Equity volatility | 18% p.a. | Nifty 50 historical |
| General inflation | 6% p.a. | RBI / MoSPI CPI |
| Healthcare inflation | 12% p.a. | India hospital cost data |
| LTCG (equity) | 12.5% over ₹1.25 L | Finance Act 2024 |
| Section 87A rebate ceiling | ₹12 Lakh | Finance Act 2025 |
| Section 80TTB (senior) | ₹50,000 | Income-tax Act |
| Surcharge | 10–25% above ₹50 L | FY 2025-26 |
| Health & Education Cess | 4% | FY 2025-26 |

All defaults are user-editable in the UI.

## Project structure

```
.
├── index.html                          # The calculator (production filename)
├── llms.txt                            # llmstxt.org-style site context for LLMs
├── pricing.md                          # Machine-readable pricing (free, no signup)
├── robots.txt                          # Crawl directives + AI-bot allowlist
├── sitemap.xml                         # XML sitemap (hreflang + image)
├── site.webmanifest                    # PWA manifest
├── favicon.ico
├── favicon.svg
├── apple-touch-icon.png
├── android-chrome-192x192.png
├── android-chrome-512x512.png
├── maskable-icon-512x512.png
├── og-image.jpg                        # 1200×800 social-preview image
├── README.md
└── .gitignore
```

The calculator is fully self-contained — HTML, CSS, and JS in a single file. No build step, no bundler, no external runtime dependencies.

## Run locally

Open the file directly in any modern browser:

```bash
open index.html
```

Or serve over HTTP if you want to test PWA / `localStorage` / `fetch` behaviour the way a deployed site sees it:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000/>.

## Deploy

Any static host works (Netlify, Vercel, Cloudflare Pages, GitHub Pages, S3 + CloudFront, plain Nginx). Upload the repository contents as-is — no build is required.

Currently deployed at `retirement.techdevix.com`.

## Methodology and limitations

**Methodology.** Year-by-year deterministic simulation for the four named strategies, plus a 500-run Monte Carlo with normal-distribution equity returns clamped at -55%. Tax module: FY 2025-26 New Regime with Section 87A rebate (incl. marginal relief), 4% cess, 10–25% surcharge, Section 80TTB (₹50K for 60+), and LTCG 12.5% with ₹1.25 L exemption. The "Spouse on board" toggle splits joint income across two filers.

**Limitations.** The model uses smooth or normal-distributed returns — real markets are fat-tailed and serially correlated. There are no idiosyncratic shocks (job loss, fraud, divorce, catastrophic uninsured medical events). Tax law may change.

> **This is illustrative analysis, not investment advice.** For specific advice, consult a SEBI Registered Investment Adviser (RIA) or a qualified Chartered Accountant.

## Privacy

- All financial calculations run client-side in your browser
- Inputs persist in `localStorage` on your device — cleared on Reset or by clearing browser site data

## License

No formal open-source license is attached. The project is "view-source / save-to-disk / modify-locally" friendly in spirit; please don't republish a verbatim copy under your own brand. If you'd like to fork or reuse meaningful portions, open an issue or get in touch.
