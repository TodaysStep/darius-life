"""Read-only deployment readiness. Reports known flags, never response bodies."""
import json
import os
import re
import sys
import urllib.error
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def inspect():
    names = ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "BENCH_OWNER_EMAIL",
             "BENCH_DESK_OWNER_ID", "BENCH_DESK_PRINCIPALS")
    report = {"github_configuration": {name: bool(os.getenv(name)) for name in names},
              "cloudflare": {}, "cloudflare_access_verified": False,
              "configuration_ready": False, "production_acceptance": "not_performed"}
    token = os.getenv("CLOUDFLARE_API_TOKEN", "")
    account = os.getenv("CLOUDFLARE_ACCOUNT_ID", "")
    if not token or not re.fullmatch(r"[a-fA-F0-9]{32}", account):
        report["cloudflare"]["status"] = "deployment_credentials_missing_or_invalid"
        return report, False
    opener = urllib.request.build_opener(NoRedirect())

    def get(path):
        request = urllib.request.Request("https://api.cloudflare.com/client/v4/accounts/" + account + path,
                                         headers={"Authorization": "Bearer " + token}, method="GET")
        try:
            with opener.open(request, timeout=15) as response:
                raw = response.read(1048577)
            if len(raw) > 1048576:
                return None, "response_too_large"
            payload = json.loads(raw)
            if payload.get("success") is not True:
                return None, "provider_refused"
            return payload.get("result"), "reachable"
        except urllib.error.HTTPError as error:
            return None, "http_" + str(error.code)
        except (urllib.error.URLError, TimeoutError, ValueError):
            return None, "unavailable"

    requirements = {
        "darius-life-private-legal": ("BENCH_NOTES", "BENCH_DESK_OWNER_ID", "BENCH_DESK_PRINCIPALS"),
        "darius-life-confidential": ("BENCH_NOTES", "BENCH_OWNER_EMAIL", "ENTRUSTED_COOKIE_SECRET"),
    }
    reachable = True
    required_bindings_present = True
    for script, expected in requirements.items():
        result, status = get("/workers/scripts/" + script + "/settings")
        bindings = result.get("bindings", []) if isinstance(result, dict) else []
        present = {b.get("name") for b in bindings if isinstance(b, dict)}
        report["cloudflare"][script] = {"status": status, "required_bindings": {n: n in present for n in expected}}
        reachable = reachable and status == "reachable"
        required_bindings_present = required_bindings_present and all(n in present for n in expected)
    result, status = get("/d1/database/42490728-b48c-4332-ad61-559ebf589935")
    matches = isinstance(result, dict) and result.get("name") == "darius-life-bench-notes"
    report["cloudflare"]["bench_database"] = {"status": status, "expected_database": matches}
    # Reading metadata proves access, not deployed code, migration, or a journey.
    report["cloudflare_access_verified"] = reachable and matches
    report["configuration_ready"] = report["cloudflare_access_verified"] and required_bindings_present and all(report["github_configuration"].values())
    return report, report["configuration_ready"]


if __name__ == "__main__":
    report, configured = inspect()
    output = json.dumps(report, indent=2, sort_keys=True)
    print(output)
    summary = os.getenv("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as file:
            file.write("### Bench Notes read-only readiness\n\n```json\n" + output + "\n```\n")
    sys.exit(0 if configured else 1)
