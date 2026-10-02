# Versioning and releases

Alex (`furinvader`) authorizes release publication. Thrallwright is released as
one Linux application; its three private workspace packages ship together and
are not published to npm. This procedure defines future releases. It does not
declare the current checkout a release or publish a tag.

## Version policy

Use `X.Y.Z` application versions and immutable `vX.Y.Z` Git tags. Before 1.0,
increment the patch for compatible fixes and the minor for new features or
breaking changes, resetting the patch to zero. Describe breaking changes
explicitly even while the application is pre-1.0. At 1.0 and later, use a major
increment for incompatible changes, a minor for compatible features, and a patch
for compatible fixes. Conventional commit headers help assemble notes; they do
not automatically choose or publish a version.

## Prepare a release PR

1. Open a release issue proposing the version, included changes, and any
   compatibility or migration consequences. Choose the version with Alex.
2. Create a normal task branch and a release-preparation PR. Keep the release
   notes in its description; link included PRs and the verification evidence.
3. Synchronize the release metadata below, regenerate the lockfile deliberately
   when needed, and follow the
   [dependency/cache procedure](development.md#dependency-versions). Do not
   delete or casually regenerate the lockfile.
4. Run the [release checks](#release-checks), resolve review findings, and
   obtain explicit authorization to merge. A merged release-preparation PR is
   separate from authorization to publish its tag and GitHub Release.

The version inventory is:

| Location                                                      | Release action                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------- |
| The three workspace `package.json` files                      | Set all three package versions to the application version.       |
| Exact `workspace:` dependency references and `pnpm-lock.yaml` | Match the referenced package versions and retain exact pins.     |
| Application and pnpm dependency-cache versions in `flake.nix` | Match the application version; verify the dependency-cache hash. |
| Codex `clientInfo.version` in the server adapter              | Match the application version reported by this client.           |
| Root `package.json`                                           | Remains a private, unversioned workspace coordinator.            |

At the initial workflow rollout, server/contracts, Nix metadata, and Codex
client metadata are `0.1.0`, while web is `0.0.0`. These are existing
development values, not evidence of a synchronized release. The first
release-preparation PR must reconcile them. That synchronization is
intentionally not a side effect of documenting this procedure.

## Release checks

Run `just setup`, then `just check-release --version X.Y.Z` with the proposed
version in the pinned Nix environment. Setup is the prerequisite that verifies
the frozen lockfile; the release checker compares workspace versions and exact
local references, root coordinator metadata, evaluated Nix application/cache
versions for the current Linux architecture, and the Codex initialize request
client version. It reads the adapter with the installed TypeScript parser and
fails if that metadata can no longer be identified. It does not rewrite files,
build the package, synchronize versions, tag, or publish. A failure to evaluate
Nix or inspect metadata is a failed check, not evidence of consistency.

This command is separate from ordinary CI: the initial web `0.0.0` version
intentionally causes `just check-release --version 0.1.0` to fail until a
release PR synchronizes it. A passing metadata check alone does not establish
release readiness or authorization.

Also run `just check`, `just test-e2e`, and `just package-smoke`. Record
commands, revision, results, and the architectures actually tested. Where
available, `just ci` combines source and browser checks. Check the final PR's
commit/title conventions and required GitHub checks.

For changes affecting the harness boundary, run the read-only `just probe` and
review the [integration evidence](integration/codex.md). Run authenticated,
paid-model smoke checks only deliberately with authorization; describe exactly
which capabilities were verified and which remain fixture-only or unverified. Do
not imply that a release smoke test covered approvals it did not encounter.

After merging, verify that `check`, `package`, and `commit-conventions` all
passed on the exact merged commit selected for the tag. A green earlier PR
revision does not establish that the merged commit passed. CI currently verifies
x86_64 Linux; aarch64 Linux is a flake target but must not be described as
release-tested without separate evidence.

## Publish after authorization

Obtain Alex's explicit authorization for the selected version and commit. From a
clean checkout, fetch `main` and identify that green merged commit. Replace the
placeholders below; `RELEASE_COMMIT` must be the verified full commit ID.

```sh
(
  set -eu
  test -s /tmp/thrallwright-release-notes.md
  git fetch origin main --tags
  RELEASE_VERSION=0.1.0 # Example only; use the agreed version.
  RELEASE_TAG="v$RELEASE_VERSION"
  RELEASE_COMMIT=VERIFIED_FULL_COMMIT_ID
  git merge-base --is-ancestor "$RELEASE_COMMIT" origin/main
  git tag -a "$RELEASE_TAG" "$RELEASE_COMMIT" -m "Release $RELEASE_TAG"
  git push origin "refs/tags/$RELEASE_TAG"
  gh release create "$RELEASE_TAG" --repo furinvader/thrallwright --verify-tag --title "Thrallwright $RELEASE_TAG" --notes-file /tmp/thrallwright-release-notes.md
)
```

Prepare the notes file before running the publication commands. Include the
user-visible changes and linked PRs, compatibility/migration consequences,
tested architectures and checks, known limitations, and pinned installation
instructions. No additional binary distribution or npm publication is implied.
The subshell stops on any failed guard or publication command without changing
the caller's shell options.

Tags are not moved or reused. If publication fails after pushing the tag,
inspect the remote tag and GitHub Release before retrying; create the missing
release against the verified existing tag. If a published release needs
correction, record the problem and prepare a new version rather than
force-pushing its tag. Read back the published tag's commit and release URL and
record them in the release issue before closing it.

## Install a specific revision

Unqualified `github:furinvader/thrallwright` installs follow the repository's
default branch when resolved. Use a published tag or full commit ID for a
specific source revision:

```sh
RELEASE_REF=v0.1.0 # Example only; use an existing tag or a full commit ID.
nix run "github:furinvader/thrallwright/$RELEASE_REF" -- --workspace "$PWD"
nix profile add "github:furinvader/thrallwright/$RELEASE_REF#thrallwright"
```

These commands use the selected revision's lockfile. Keep development installs
and published-release claims distinct. If publication or verification is
blocked, leave the release issue open with its owner, exact blocker, completion
steps, and outstanding evidence, following the
[contribution workflow](../CONTRIBUTING.md).
