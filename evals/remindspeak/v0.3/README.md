# RemindSpeak v0.3 blinded preference study

Run `pnpm remindspeak:study:prepare`, then send participants only
`blind-study.html`. Do not send `sealed-source-key.json`.

Each participant completes every comparison in a browser and returns the
downloaded anonymous JSON response. Place those files in `responses/`, then run
`pnpm remindspeak:study:score`.

The prespecified promotion gate requires at least five human participants and
120 judgments, a candidate preference score of at least 60%, a 95% Wilson lower
bound of at least 50%, and no more than a 1% candidate fact-issue rate. Run
`pnpm remindspeak:study:gate` when a collected study is ready to enforce the
gate. Until then, the report truthfully remains `awaiting-participants` or
`insufficient-sample`.
