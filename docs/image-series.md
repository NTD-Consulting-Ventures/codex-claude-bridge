# Best practices for image series

What worked in a two-day field run of 0.2.3 (about 220 image jobs for a picture book, from
two parallel Claude sessions, mostly with reference images, partly on an unstable mobile
hotspot), and how 0.3.0 builds it in. The bridge runs locally, but every Codex turn and
every image is generated on OpenAI's servers: network and backend speed decide most
outcomes.

## Before you start

- **Give jobs enough time.** The default limit is 300 s per job. One image normally takes
  60–120 s, under load up to about 4 min. Pass `timeout_s` per job (10–900), or register
  with `CODEX_TASK_WALL_SECONDS=600` (see [setup](setup.md#job-timeout)). Rule of thumb:
  120–240 s per image you expect in the job.
- **One image per job under load; two or three when images take 60–90 s; never four or
  more** in one job. Several small jobs lose less when one fails.
- **Check `codex_status`** first: `limits.job_timeout_s` shows the effective default (and
  `env_issue` if your env value was ignored or capped), `last_job` shows how the previous
  job ended.

## Reference images

- Put references in the project folder (`cwd`) and pass them as `reference_images`
  (paths relative to `cwd`, PNG or JPEG, up to 8 files, 20 MiB each, 64 MiB total). They
  reach Codex as native image input. `codex_status` shows `reference_images.support` once
  the installed Codex schema has been checked (after the first image job); an older Codex
  without `localImage` input gets `REFERENCE_IMAGES_UNSUPPORTED` and no job starts.
- **Bundle many references into a few boards.** For example, one board per scene with all
  character sheets, each with a dark name label, plus one board for props. Three to five
  files per job keep the model's attention on what matters, and the labels make the
  mapping unambiguous.
- **Corrections as edits.** Pass the previous version as a reference plus "Keep it exactly
  as it is, only change: …". This is much more stable than generating from scratch.
  Within one bridge process you can also continue the same image thread with its
  `session_handle` ([image sessions](image-sessions.md)).
- Fallback for a Codex without `localImage`: `codex_task_start` with the files in `cwd` and
  a prompt that lists the relative paths with their purpose and says "Open them with your
  image viewing tool". Codex then looks at them itself.

## Prompts

- Name the format: `aspect` on `codex_image_generate` (`"1:1"`, `"2:1"`, `"3:2"`, …) adds a
  fixed phrase, and every saved file reports `width` and `height` so you can check it. In
  the field run "wide landscape 2:1" gave 1774×887 and "SQUARE 1:1" gave 1254×1254.
- For `codex_task_start`: "Make exactly ONE native image (no retries, no extra images)" and
  "Do not create, edit or delete any files yourself. Finish with "ok" or the reason it
  failed." (`codex_image_generate` already instructs this natively.)
- Transparency is not guaranteed. Files report `has_alpha`. If you need cut-outs, ask for
  "a perfectly flat uniform grey background (#8F8F8F)" and remove it locally (flood fill).

## While a job runs

- Use `codex_task_wait` (up to 120 s per call) instead of polling `codex_task_status`.
- `progress.files_so_far` lists images that are already saved and verified, so you can
  start working on them before the job finishes. `progress.images_completed`,
  `first_model_event_ms` and `last_event_at` show whether the model is working at all.
- To line up several jobs, pass `queue: true` (up to 8 queued jobs; not with
  `session_handle`). Each job keeps its own `timeout_s`, which starts when it runs.

## When a job fails

1. **Look at `partial_files` first.** A failed, timed-out or cancelled job keeps every
   image that was already generated, verified and saved, including images Codex saved for
   the turn but never reported (`source: "thread_folder"`). Never re-run what is already
   there: that spends quota twice.
2. **Read `error.likely_cause` and `error.retryable`.** They are hints, and nothing is
   retried automatically:
   - `network`: Codex kept reconnecting (unstable connection). Wait until the connection has
     been stable for about a minute, then continue the queue.
   - `slow_generation`: the model was working but the limit was too short. Raise
     `timeout_s` or put fewer images in a job.
   - `no_model_response` / `stalled`: the backend did not answer or stopped answering.
     Wait a little, then try a single image.
   - `startup`: Codex itself did not get going (often no network at all).
   - `quota` / `rate_limit`, `auth`, `content_policy`, `request`: change something before
     trying again.
3. **Continue from a partial image** by starting a fresh job with that file in
   `reference_images`. A failed job revokes its image session, so `session_handle` cannot
   continue it.
4. Only if the bridge itself is gone (restart), look in `~/.codex/generated_images/` for
   files newer than the job start. With several sessions in parallel this folder mixes
   their images, so match by time and content, not by "newest".
