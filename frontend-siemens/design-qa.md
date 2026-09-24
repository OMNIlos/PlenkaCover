# Design QA — redlined UI cleanup

## Reference

Eight screenshots supplied by the user on 2026-08-04 cover:

- commercial control analytics;
- production roll queue;
- production operator load;
- production raw-material inventory;
- finance payments;
- director production and material analytics;
- director raw-material inventory.

The red strike-through marks were treated as removals. The red notes were treated as
implementation requirements.

## Implemented checks

- Removed the 1C production-source banner from commercial and director analytics.
- Kept the underlying comparison data and API contracts intact.
- Increased the commercial grouping control height to align with neighboring controls.
- Removed redundant roll-queue labels while preserving all selects and their behavior.
- Replaced the operator-load row click target with an accessible disclosure button.
- Preserved the operator-load detail tabs and queue/order breakdown.
- Removed stale-source banners and row-level source diagnostics from shared raw-material
  inventory views without deleting source facts.
- Removed the marked finance shell badges, duplicated count, detail metadata, and state pill
  only from the finance presentation.

## Automated evidence

- Targeted regression tests: passed.
- Full Vitest suite: 176 files passed, 1 skipped; 1412 tests passed, 1 skipped.
- Production build: passed.
- Harness contracts: passed.
- Release contracts: passed.
- Visual-noise policy: passed.
- Dependency security: passed, 0 vulnerabilities.
- `git diff --check`: passed.

The CSS-debt audit remains above its historical repository baseline because of pre-existing
legacy styles outside this change. This patch does not expand that unrelated debt.

## Visual comparison

The configured in-app browser reported no available browser instance, so a rendered
same-viewport screenshot comparison could not be completed in this environment. Direct
Playwright fallback was intentionally not used because the active browser workflow requires
explicit user approval for that fallback.

Result: blocked

---

# Design QA — payroll tariff orders (2026-08-13)

## Reference and comparison state

- Reference: `/Users/ilagulakin/Desktop/Снимок экрана — 2026-08-13 в 12.15.17.png`.
- Reference raster: 2940 × 1668; comparison render: the same 1470 × 834 CSS viewport at 2×.
- Payroll state matches the reference totals, two operators, excluded defect evidence, and
  published order № 8-09/25.
- The reference and implementation screenshots were inspected together after the final render.

## Findings and fixes

- Preserved the existing Siemens dark shell, payroll hierarchy, table-first layout, spacing,
  typography, borders, and status colors.
- Added the requested primary action beside the tariff disclosure without displacing payroll
  evidence or hiding the applied order.
- Kept the already-approved removal of redundant `Разбивка` labels; this is the only intentional
  row-density difference from the older reference.
- Prevented an old tariff editor from flashing and accepting input while a fresh order copy is
  loading.
- Removed the overlay gutter for the tariff dialog below 900 px so the 390 × 844 workflow is
  genuinely full-screen; the footer remains visible and the matrix owns its local scroll area.
- Confirmed no document-level horizontal overflow at 1440 × 900, 1366 × 768, 390 × 844, and
  1470 × 834.

## Interaction evidence

- Keyboard disclosure and Escape close: passed.
- Close-button focus restoration: passed.
- Cancel without orphan draft: passed.
- Create → save → review → publish: passed.
- Published read-only state: passed.
- Stale-revision recovery retains local input and rotates the operation key: passed.
- Navigation, closing, editing, and duplicate submission remain locked during mutation: passed.
- Prohibited Gateway, device-admin, and 1C requests: none.
- Browser runtime, API, visible-error, and overflow diagnostics: passed.

The reproducible gate is `npm run check:payroll-tariff-orders`; each run writes disposable
screenshots outside Git and prints their directory. Latest evidence:
`/var/folders/_p/7419w4kn7yngv1qqcxf3qzk40000gn/T/plenka-payroll-tariff-orders-Jkh95I`.
No VPS deployment or external publication was performed.

Result: passed
