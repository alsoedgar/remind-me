# PlanScan research workspace

PlanScan is Remind Me's original compact document-layout model. It reads the positioned words that PDF.js or local Tesseract already extracted, then predicts block roles, entity roles, plan links, document type, and confidence. Its graph decoder can group a title, date, time, place, and description across vertical cards or table rows.

The model is trained from zero initialization with NumPy. It does not download or initialize from LayoutLM, a vision-language model, a teacher, or any other pretrained weights. Python is a development dependency only; the installed Electron app runs the per-channel INT8 table in a dependency-free TypeScript decoder inside the sandboxed document Web Worker.

## Reproduce

```bash
pnpm planscan:generate
pnpm planscan:train
pnpm planscan:check
```

`planscan:train` regenerates 16,000 program-first pages, trains six task heads, evaluates disjoint layout assets, quantizes the 5,242,880 coefficients, exports the compressed model, and refreshes `models/manifest.json`. The generated corpus and float checkpoints remain ignored under `ml/planscan/.generated`; the data manifest, 96-page TypeScript fixture, reports, configuration, and release weights are tracked.

## Boundary

PlanScan never reads a filesystem path, performs OCR, resolves a date, or writes calendar data. Every emitted span must be an exact substring of a known source block, every relationship stays on one source page, and every proposal still passes the deterministic calendar compiler and editable batch review. Missing or corrupt weights fall back to the Phase 4 rules planner.

See [MODEL_CARD.md](MODEL_CARD.md) and [the architecture guide](../../docs/architecture/planscan.md).
