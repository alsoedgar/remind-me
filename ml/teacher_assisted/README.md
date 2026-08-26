# Qwen-assisted teacher lab

This development-only lab transfers narrow language coverage from the optional
Qwen3 1.7B Q4 pack into the project-owned RemindCore and RemindSpeak students.
It is **data distillation**, not weight copying: both student tables still begin
at zero and are trained by this repository's NumPy pipelines.

The teacher is allowed to provide only:

- delexicalized calendar-request wording around protected markers such as
  `<TITLE>` and `<DATE>`; and
- a preference index over four project-authored response candidates whose
  protected facts and placeholder signatures have already been validated.

Project code supplies operation labels and placeholder signatures, rejects
semantic drift, duplicates, unprotected facts, unsafe write claims, and persona
claims, and reserves disjoint RemindCore templates for a teacher challenge set.
Free-generated RemindSpeak atoms were tested, failed the quality gate, and were
all rejected. No personal calendar data or conversation history is used.

Run from the workspace root:

```bash
pnpm teacher:generate
pnpm teacher:prepare
pnpm teacher:curate
pnpm teacher:check
```

Generation reads the already installed, SHA-256-pinned Qwen pack and checkpoints
after every batch. It never downloads a model. `raw/` records the teacher output;
`accepted/` is the only input the student pipelines may consume.

The accepted corpus currently contains 73 RemindCore request templates, 14 hard
OOD messages, and 66 RemindSpeak preference annotations. One template per
RemindCore operation and one preference per RemindSpeak speech act are held out
from training. The curation report also records every rejection category and the
exact Qwen model digest.

The design follows evidence that constrained paraphrase generation can improve
intent/slot systems, while selection and filtering matter more than simply
adding synthetic volume: [data-efficient paraphrase generation](https://aclanthology.org/2020.coling-industry.2/),
[annotated intent/slot generation](https://aclanthology.org/2022.coling-1.18/),
and [selective in-context augmentation](https://aclanthology.org/2023.eacl-main.107/).
The teacher choice and deployment tier are documented against the
[Qwen3 technical report](https://arxiv.org/abs/2505.09388/).

The resulting checkpoints must be described as **project-owned, zero-initialized,
Qwen-assisted synthetic-data models**. They must not be described as having no
teacher data, and their generated/challenge metrics are not a substitute for an
independently collected human blind evaluation.
