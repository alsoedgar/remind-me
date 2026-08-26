# RemindSpeak research workspace

RemindSpeak is Remind Me's original grounded response-generation track. Version 0.3 is a bounded 28.31M-parameter PhraseLattice trained from zero initialization over verified `ResponsePlan` features and selectively distilled Qwen preference labels. It imports no pretrained weights or Qwen prose and never receives a database handle.

The pipeline builds a 40,000-example base corpus, adds 1,650 rows from 55 audited Qwen rankings over project-authored candidates, trains three sparse INT8 heads, and scores 432 reviewed atoms across 18 protected speech acts and 20 styles. The runtime overgenerates five candidates, validates exact placeholders, rejects unsafe literals and exact recent replies, applies style/novelty and bounded local-preference ranking, and retains deterministic templates as the final fallback.

```bash
python ml/remindspeak/pipeline.py all
pnpm models:onnx:export
pnpm teacher:check
pnpm models:verify
pnpm remindspeak:check
pnpm remindspeak:study:prepare
pnpm remindspeak:study:score
```

Python is development-only. Installed applications bundle the compressed model and use the dependency-light TypeScript runtime. The randomized blind study remains honest about its state: its report says `awaiting-participants` until real people return responses.

See [MODEL_CARD.md](MODEL_CARD.md) and [the architecture note](../../docs/architecture/remindspeak.md) for evaluation results and limitations.
