#!/usr/bin/env bash
set -euo pipefail

repository_root="$(git rev-parse --show-toplevel)"
cd "${repository_root}"

for scanner in gitleaks git-secrets; do
  if ! command -v "${scanner}" >/dev/null 2>&1; then
    printf 'Required scanner is not installed: %s\n' "${scanner}" >&2
    exit 2
  fi
done

AWS_ACCESS_KEY_ID_PATTERN='(A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}'
AWS_SECRET_KEY_PATTERN="(\"|')?(AWS|aws|Aws)?_?(SECRET|secret|Secret)?_?(ACCESS|access|Access)?_?(KEY|key|Key)(\"|')?\\s*(:|=>|=)\\s*(\"|')?[A-Za-z0-9/+=]{40}(\"|')?"
AWS_ACCOUNT_ID_PATTERN="(\"|')?(AWS|aws|Aws)?_?(ACCOUNT|account|Account)_?(ID|id|Id)?(\"|')?\\s*(:|=>|=)\\s*(\"|')?[0-9]{4}-?[0-9]{4}-?[0-9]{4}(\"|')?"

run_git_secrets() {
  git \
    -c 'secrets.providers=git secrets --aws-provider' \
    -c "secrets.patterns=${AWS_ACCESS_KEY_ID_PATTERN}" \
    -c "secrets.patterns=${AWS_SECRET_KEY_PATTERN}" \
    -c "secrets.patterns=${AWS_ACCOUNT_ID_PATTERN}" \
    -c 'secrets.allowed=AKIAIOSFODNN7EXAMPLE' \
    -c 'secrets.allowed=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' \
    "$@"
}

printf '%s\n' '==> Gitleaks: complete Git history'
gitleaks git --no-banner --redact=100 --log-opts='--all' .

if ! git diff --cached --quiet; then
  printf '%s\n' '==> Gitleaks: staged changes'
  gitleaks git --no-banner --redact=100 --pre-commit --staged .
fi

printf '%s\n' '==> git-secrets: complete Git history with AWS patterns'
run_git_secrets secrets --scan-history

printf '%s\n' '==> git-secrets: tracked and untracked working-tree files'
run_git_secrets secrets --scan --untracked

printf '%s\n' 'Secret scans completed without findings.'
