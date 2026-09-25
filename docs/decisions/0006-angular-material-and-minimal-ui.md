# ADR 0006: Angular Material and a minimal first interface

Status: Accepted, 2026-09-25. Implemented for the first slice; see the [workbench guide](../workbench.md) and [integration evidence](../integration/codex.md).

## Context

The first version should provide the simplest interface that is useful for observing and directing a session while inspecting workflow state. The maintainer has a future UI vision that may change layout and appearance; its requirements are deliberately deferred.

Angular is selected in [ADR 0002](0002-angular-ui.md). The maintainer has good experience with Angular Material, and its ready-made controls and consistent design support the current priority. Product behavior remains defined in the [product specification](../product-spec.md) and [first implementation slice](../first-slice.md).

## Decision

Use Angular Material for the first interface. Use its controls directly where needed, with one straightforward theme and ordinary CSS Grid/Flexbox for page layout.

Start with these areas in one simple workbench:

- Workspace context and integration availability.
- A session list with status and attention indicators.
- Activity for the selected session, input, approvals, and supported execution controls.
- A workflow view for arbitrary JSON and source errors.

Keep session activity and workflow state easy to inspect in the same work loop. Exact sizing and arrangement can evolve during implementation. Resizable panels, elaborate navigation, and custom branding are deferred until concrete use justifies them.

## Components and styling

Use Material buttons, inputs, lists, menus, and dialogs when the interaction calls for them. Activity, approval, and workflow views remain small application feature components. Material does not determine transcript rendering, workflow semantics, or execution behavior.

Use supported theme configuration for color, typography, density, and any necessary component overrides. Keep layout styles local and customization modest. [Material theming](https://github.com/angular/components/blob/main/guides/theming.md)

Keep state and commands in the presentation services and contracts defined by ADR 0002. Material-specific APIs belong in UI code. Create reusable application components when they capture meaningful behavior; avoid speculative wrappers around every Material control or a new theme framework.

## Alternatives and future changes

Angular Aria supplies interaction and accessibility primitives while leaving markup and styling to the application. It offers more control when a concrete custom design requires it, with more initial implementation work. [Angular Aria overview](https://angular.dev/guide/aria/overview)

Aria may later be introduced for specific components alongside retained Material controls. Such changes require template, styling, and interaction work. Feature boundaries and independent service contracts limit their impact without promising a drop-in migration.

No additional UI store, virtualization library, layout package, or custom design system is installed. [apps/web/package.json](../../apps/web/package.json) pins the UI dependencies. The first slice uses Material's `azure-blue` prebuilt theme through [angular.json](../../apps/web/angular.json), with application styles in [styles.scss](../../apps/web/src/styles.scss) and workbench layout in [app.scss](../../apps/web/src/app/app.scss).

## Verification during implementation

Verify keyboard access, clear control labels, readable activity, and visible local error states. Approvals and execution controls must reflect current capabilities and source state. Material components support the interface, but the composed workflow still needs interaction checks. Navigation and layout changes must not issue execution commands.
