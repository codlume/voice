# Flow statecharts

Each chart shows the states a stateful flow passes through, what the user sees in each, and the rules a verifier checks. A TLA+ model of the real code backs each chart, and TLC checks every rule. Every model also passes TLC's deadlock check. A red state breaks a rule. Its file gives the path and says whether the break is a bug or a design choice.

| Flow                         | Chart                          | Feature                                 |
| ---------------------------- | ------------------------------ | --------------------------------------- |
| Dictation session            | [dictation.md](dictation.md)   | [Dictation](../features/dictation.md)   |
| Transforms                   | [transforms.md](transforms.md) | [Transforms](../features/transforms.md) |
| Meeting recording            | [meetings.md](meetings.md)     | [Meetings](../features/meetings.md)     |
| Speech and cleanup model     | [models.md](models.md)         | [Models](../features/models.md)         |
| Account sign-in and sign-out | [account.md](account.md)       | [Account](../features/account.md)       |

Use a chart to pick what to verify. A change that touches a flow's states should be proven in each state it changes, including the error and recovery states, not only the happy path.

## Keep the charts true

Each flow has four files: `<flow>.tla` and `<flow>.cfg` are the model, `<flow>.view.mjs` labels it in the user's words, and `<flow>.md` embeds the chart. Each rule in `<flow>.cfg` has one bullet in `<flow>.md` that starts with ``- `Rule` holds`` or ``- `Rule` breaks``.

CI runs `statecharts.mjs`, which runs TLC once for each rule and fails when TLC's result differs from the rule's bullet, when a rule has no bullet, or when a model deadlocks. After a change to a flow's code, update its model and its rule bullets, then run the same check from the repository root. It needs Java 11 or later, or `JAVA` set to a java binary. The first run downloads TLC.

```sh
node .claude/skills/verify/scripts/statecharts.mjs
```

A model change can also change the chart. To redraw it, run this from the repository root. It needs the pstack `statechart` skill and [mise](https://mise.jdx.dev) on `PATH`.

````sh
statechart=$(ls -d ~/.claude/plugins/cache/pstack-claude/pstack/*/skills/statechart/scripts/statechart | sort -V | tail -1)
for flow in dictation transforms meetings models account; do
  dir=.claude/skills/verify/statecharts
  out=$(mktemp -d)
  "$statechart" "$dir/$flow.tla" --config "$dir/$flow.cfg" --view "$dir/$flow.view.mjs" --out "$out" >/dev/null
  if awk '/^```mermaid$/{f=1;next} /^```$/{f=0} f' "$dir/$flow.md" | diff -q - "$out/chart.mmd" >/dev/null; then echo "$flow: in sync"; else echo "$flow: changed, see $out"; fi
done
````

For a flow that reports `changed`, copy `chart.mmd` into the Mermaid block of `<flow>.md`, and update the rules and results from `report.md` in the same folder.
