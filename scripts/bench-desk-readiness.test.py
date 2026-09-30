import importlib.util
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("readiness", Path(__file__).with_name("bench-desk-readiness.py"))
readiness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(readiness)


class ReadinessTests(unittest.TestCase):
    def inspect_metadata(self, include_bindings):
        secret = "synthetic-secret-never-reported"
        env = dict.fromkeys(("CLOUDFLARE_API_TOKEN", "BENCH_OWNER_EMAIL", "BENCH_DESK_OWNER_ID", "BENCH_DESK_PRINCIPALS"), secret)
        env["CLOUDFLARE_ACCOUNT_ID"] = "a" * 32

        class Provider:
            def open(self, request, timeout):
                self.assert_request(request)
                if "/d1/database/" in request.full_url:
                    result = {"name": "darius-life-bench-notes", "private_value": secret}
                else:
                    names = ("BENCH_NOTES", "BENCH_DESK_OWNER_ID", "BENCH_DESK_PRINCIPALS", "BENCH_OWNER_EMAIL", "ENTRUSTED_COOKIE_SECRET")
                    result = {"bindings": [{"name": n, "text": secret} for n in names] if include_bindings else []}
                return io.BytesIO(json.dumps({"success": True, "result": result}).encode())

            def assert_request(self, request):
                assert request.method == "GET"
                assert request.full_url.startswith("https://api.cloudflare.com/client/v4/accounts/")

        with patch.dict(os.environ, env, clear=True), patch.object(readiness.urllib.request, "build_opener", return_value=Provider()):
            report, ready = readiness.inspect()
        self.assertNotIn(secret, json.dumps(report))
        return report, ready

    def test_resource_access_does_not_claim_configuration_ready_without_bindings(self):
        report, ready = self.inspect_metadata(False)
        self.assertTrue(report["cloudflare_access_verified"])
        self.assertFalse(report["configuration_ready"])
        self.assertFalse(ready)

    def test_known_configured_bindings_still_do_not_claim_production_acceptance(self):
        report, ready = self.inspect_metadata(True)
        self.assertTrue(ready)
        self.assertEqual(report["production_acceptance"], "not_performed")

    def test_missing_credentials_make_no_provider_request(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(readiness.urllib.request, "build_opener") as opener:
            report, ready = readiness.inspect()
        opener.assert_not_called()
        self.assertFalse(ready)
        self.assertFalse(report["cloudflare_access_verified"])


if __name__ == "__main__":
    unittest.main()
