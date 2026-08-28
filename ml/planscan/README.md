# PlanScan research workspace

PlanScan is Remind Me's original compact document-layout model. It reads the positioned words that PDF.js or local Tesseract already extracted, then predicts block roles, entity roles, plan links, document type, and confidence. Its graph decoder can group a title, date, time, place, and description across vertical cards or table rows.

The model is trained from zero initialization with NumPy. It does not download or initialize from LayoutLM, a vision-language model, a teacher, or any other pretrained weights. Python is a development dependency only; the installed Electron app runs the per-channel INT8 table in a dependency-free TypeScript decoder inside the sandboxed document Web Worker.

## Reproduce

```bash
pnpm planscan:generate
pnpm planscan:train
pnpm planscan:check
```

`planscan:train` regenerates 21,000 program-first pages (16,000 train, 2,500 development, and 2,500 test), trains six task heads, evaluates disjoint layout assets, quantizes the 5,242,880 coefficients, exports the compressed model, and refreshes `models/manifest.json`. Native-text and OCR pages are balanced across baseline, OCR corruption, neighboring-row negatives, repeated titles, unfamiliar column order, and header/footer distractions. The generated corpus and float checkpoints remain ignored under `ml/planscan/.generated`; the data manifest, stratified 120-page TypeScript fixture, reports, configuration, and release weights are tracked.

## Boundary

PlanScan never reads a filesystem path, performs OCR, resolves a date, or writes calendar data. Every emitted span must be an exact substring of a known source block, every relationship stays on one source page, and every proposal still passes the deterministic calendar compiler and editable batch review. Missing or corrupt weights fall back to the Phase 4 rules planner. When PlanScan and rules disagree over one exact source anchor, an enabled optional local Qwen pack may select only one already validated, exactly cited draft or withhold. That advisory response cannot synthesize fields or save data.

See [MODEL_CARD.md](MODEL_CARD.md) and [the architecture guide](../../docs/architecture/planscan.md).
