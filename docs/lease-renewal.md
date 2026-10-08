# Bounded renewal for a healthy job attempt

`POST /internal/jobs/renew` uses the existing private runner authentication and
accepts only `jobId` and `attemptCount`. It renews an unexpired, running, current
attempt using a conditional SQLite update and the database clock. Canonical UTC
lease and start timestamps are required. It never claims a job, increments an
attempt, resets its start time, changes its status, or writes a result/event.

The Workflow renews inside each existing callback, including retries, before
loading input, planning, invoking the container, judging, or completing a job.
It checks the server's remaining lease against that callback's existing timeout,
subtracting the measured request round trip. Rejected or malformed renewal
acknowledgements cannot authorize work. The existing bounded Workflow retries
may retry a renewal RPC before the outer catch handles lease rejection; zero
step retries or immediate deployed termination are not claimed. A newer attempt's
lease remains intact.
Expired attempts continue through the existing bounded recovery path; renewal
cannot resurrect them. A long suspension exceeding the active lease still expires.

Each renewal grants at most 3,600 seconds. Total attempt age is also finite:

| Job | Horizon from original `started_at` (seconds) |
| --- | ---: |
| plan | 13,310 |
| render / export | 20,690 |
| revision | 22,580 |

These horizons preserve the original 3,600-second claim-to-dispatch allowance
and sum the supported Workflow callback budgets. Existing explicit steps have
two retries (three attempts), with 30- and 60-second exponential retry gaps:
load = 990 seconds; plan / revision plan / judge = 1,890 seconds each;
execute = 6,390 seconds. Existing unconfigured completion/failure steps use the
Workflow defaults: six attempts of ten minutes and gaps 10+20+40+80+160 seconds,
or 3,910 seconds. Both terminal allowances are included: completion may exhaust
its retries before the Workflow records a failure. The completion promise is
now awaited inside the guarded path; this changes the prior asynchronous failure
path so lease rejection stops terminally and transient completion exhaustion can
be recorded. No planner, renderer or Judge work is repeated during those terminal
retries. Retry limits, per-attempt timeouts, provider budgets, claims, and
all-slide/current-attempt Judge gates are unchanged. If the finite horizon no
longer covers a callback's timeout, the runner stops before starting that work.

Retry/default semantics: [Cloudflare Workflows documentation](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/).

Owned tests use native disposable SQLite and the actual job API, service caller,
and Workflow. Provider/container effects are mocks; a controlled database clock
advances through the original retry durations. This proves source admission and
SQL behavior, including a healthy logical lifecycle beyond sixty minutes. It
does not prove physical elapsed time, deployed Workflow adoption, paid providers,
Preview, or the remaining issue #9 / #11 runtime acceptance.
