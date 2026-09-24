{
  description = "Thrallwright Linux runtime and development environment";

  inputs.nixpkgs.url = "https://releases.nixos.org/nixpkgs/nixpkgs-26.11pre1078969.34ca302a9572/nixexprs.tar.zst";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsFor = system: import nixpkgs { inherit system; };
    in {
      packages = forAllSystems (system:
        let
          pkgs = pkgsFor system;
          node = pkgs.nodejs_24;
          pnpm = pkgs.pnpm_10;
          source = pkgs.lib.cleanSourceWith {
            src = ./.;
            filter = path: type:
              !(builtins.elem (builtins.baseNameOf path) [
                ".git" "node_modules" "dist" ".angular" ".thrallwright-dev"
                ".direnv" "result" "playwright-report" "test-results" "coverage"
              ]);
          };
          pnpmDeps = pkgs.fetchPnpmDeps {
            pname = "thrallwright-pnpm-deps";
            version = "0.1.0";
            src = source;
            inherit pnpm;
            fetcherVersion = 3;
            hash = "sha256-23PJxNrUpYQeKw8od/K0F+ZYzaLkB9+va/irZPcNoF0=";
          };
          application = pkgs.stdenv.mkDerivation {
            pname = "thrallwright";
            version = "0.1.0";
            src = source;
            inherit pnpmDeps;
            CI = "true";

            nativeBuildInputs = with pkgs; [
              node
              pnpm
              pnpmConfigHook
              python3
              pkg-config
              gnumake
              patchelf
            ];

            # The Nix Node headers are available offline to node-gyp. The pnpm
            # hook installs without lifecycle scripts, so build the SQLite
            # binding explicitly with the selected Node ABI.
            npm_config_nodedir = node;
            npm_config_build_from_source = "true";
            THRALLWRIGHT_DYNAMIC_LINKER = pkgs.stdenv.cc.bintools.dynamicLinker;
            THRALLWRIGHT_GLIBC_LIB = "${pkgs.glibc}/lib";
            buildPhase = ''
              runHook preBuild
              pnpm --filter @thrallwright/server rebuild better-sqlite3
              bash scripts/prepare-native.sh
              pnpm build
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall
              # pnpm's legacy deploy resolves workspace ranges against online
              # metadata, which is unavailable in a Nix build. Reinstall the
              # locked production graph offline and retain its relative links.
              pnpm install --offline --frozen-lockfile --prod --ignore-scripts
              pnpm --filter @thrallwright/server rebuild better-sqlite3
              mkdir -p "$out/lib/thrallwright/apps/server" \
                "$out/lib/thrallwright/packages/contracts" "$out/bin"
              cp -a node_modules "$out/lib/thrallwright/node_modules"
              cp -a apps/server/node_modules apps/server/package.json apps/server/dist \
                "$out/lib/thrallwright/apps/server/"
              cp -a packages/contracts/node_modules packages/contracts/package.json packages/contracts/dist \
                "$out/lib/thrallwright/packages/contracts/"
              cp -r apps/web/dist/browser "$out/lib/thrallwright/web"

              test -f "$out/lib/thrallwright/apps/server/dist/cli.js"
              test -f "$out/lib/thrallwright/web/index.html"
              test -f "$out/lib/thrallwright/apps/server/node_modules/better-sqlite3/build/Release/better_sqlite3.node"

              cat > "$out/bin/thrallwright" <<EOF
              #!${pkgs.runtimeShell}
              export THRALLWRIGHT_CODEX_EXECUTABLE="${pkgs.codex}/bin/codex"
              export THRALLWRIGHT_BROWSER_OPENER="${pkgs.xdg-utils}/bin/xdg-open"
              export THRALLWRIGHT_WEB_ROOT="$out/lib/thrallwright/web"
              exec "${node}/bin/node" "$out/lib/thrallwright/apps/server/dist/cli.js" "\$@"
              EOF
              chmod +x "$out/bin/thrallwright"
              runHook postInstall
            '';

            meta = with pkgs.lib; {
              description = "Local workbench for Codex sessions and durable workflows";
              platforms = systems;
              mainProgram = "thrallwright";
            };
          };
        in {
          default = application;
          thrallwright = application;
        });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/thrallwright";
          meta.description = "Run the Thrallwright local workbench";
        };
      });

      devShells = forAllSystems (system:
        let
          pkgs = pkgsFor system;
          node = pkgs.nodejs_24;
        in {
          default = pkgs.mkShell {
            packages = with pkgs; [
              node
              pnpm_10
              just
              codex
              python3
              pkg-config
              gnumake
              gcc
              patchelf
              chromium
              curl
              git
            ];
            npm_config_nodedir = node;
            npm_config_build_from_source = "true";
            THRALLWRIGHT_DYNAMIC_LINKER = pkgs.stdenv.cc.bintools.dynamicLinker;
            THRALLWRIGHT_GLIBC_LIB = "${pkgs.glibc}/lib";
            THRALLWRIGHT_CODEX_EXECUTABLE = "${pkgs.codex}/bin/codex";
            THRALLWRIGHT_CHROMIUM_EXECUTABLE = "${pkgs.chromium}/bin/chromium";
            shellHook = ''
              export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
            '';
          };
        });
    };
}
