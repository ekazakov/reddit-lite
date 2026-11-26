# Notes

- The user writes in Russian. Lessons are in Russian.
- The user has no prior experience with metrics or statistics. See learning record 0001.
- The user asked for: explanations from fundamental attributes, comprehension questions, visualizations, HTML output.
- The user prefers to learn the base first, before the map of the stack.
- The workspace is `teach/` inside the reddit-lite repo, so it does not mix with the app code.
- A local Prometheus runs on :9090 with real data. Use it for live examples. The k6 CSV files in `loadtest/results/` hold raw request durations.
- Shared components: `assets/course.css`, `assets/quiz.js`, `assets/viz.js` (SVG helpers and the k6 percentile formula).
- Lesson order for a beginner: 2, 3, 4, 5, then 1.
- Each lesson ends with open questions. Check the answers in chat, then write learning records.
- Next lesson candidates: gauge and counter mistakes in real dashboards, then reading one real run to find the bottleneck.
