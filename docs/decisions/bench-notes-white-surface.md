# Bench Notes — white working surface

## Decision
The private Bench Notes working docket and evidence room use a white reading surface. The separate Entrusted area retains its existing aged-paper presentation and passphrase-scoped sharing behavior.

## Scope and preservation
- Apply the white surface only to pages rendered by the private working-docket and evidence-room modules.
- Preserve the existing Cloudflare Access application, allowlist, JWT audience, D1/R2 bindings, stored records, sharing flags, and guest passphrase flow.
- Do not expose private working-docket records through the Entrusted view.
- Keep filing status distinct from issuance and service; preserve the labels and source text as recorded.

## Regression coverage
- `bench-working.test.mjs`: private working docket emits the white theme.
- `bench-evidence-room.test.mjs`: evidence room emits the same white theme.
- `bench-entrusted.test.mjs`: Entrusted remains on the existing paper presentation and does not receive the working theme.
- The production workflow includes the working-docket suite and runs its regression/build gates on pull requests without deploying from a pull request.

## Production verification
Pending the production Worker deployment and founder's authenticated live review. Public unauthenticated checks must continue to stop at the existing Cloudflare Access gate.
