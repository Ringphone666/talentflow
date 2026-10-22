"""A local, evidence-linked model response for report workflow regressions."""
import json


def configure_report_assessment(monkeypatch):
    from matching_core.services import candidate_scoring

    monkeypatch.setattr(candidate_scoring, "model_settings", lambda: {
        "provider": "external", "key": "report-fixture-key", "url": "https://example.invalid",
        "confirmed": True, "http_allowed": False, "reasoning_model": "chat-primary",
        "reasoning_max_tokens": 4096,
    })

    def respond(self, text, job):
        payload = json.loads(text)
        return {
            "dimensions": [{"name": name, "score": 80, "status": "已评估", "reason": "测试材料提供相关项目记录", "evidence_ids": [0]}
                           for name in payload["job"]["weights"]],
            "hard_checks": [{"name": item["name"], "status": "无法确认", "reason": "需核验任职资格材料", "evidence_ids": []}
                            for item in payload["job"]["hard_conditions"]],
        }

    monkeypatch.setattr(candidate_scoring.ExternalModelAdapter, "analyze", respond)
