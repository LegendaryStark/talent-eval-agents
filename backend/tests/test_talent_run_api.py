from __future__ import annotations

import json
import time

from fastapi.testclient import TestClient
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

from app.main import create_app
from app.talent_decision_graph import DecisionContext
from app.talent_run_stream import RunEvent, TalentRunManager


def _job_selection_manager() -> TalentRunManager:
    builder = StateGraph(dict)

    def confirm_job(_: dict):
        decision = interrupt(
            {
                "type": "job_selection",
                "question": "请选择岗位",
                "options": [
                    {"job_code": "JD-AI-001", "name": "高级 AI 应用工程师"}
                ],
            }
        )
        return {"selected": decision["job_code"]}

    builder.add_node("confirm_job", confirm_job)
    builder.add_edge(START, "confirm_job")
    builder.add_edge("confirm_job", END)
    return TalentRunManager(
        graph=builder.compile(checkpointer=InMemorySaver()),
        context=DecisionContext(
            tenant_id="course-demo",
            permission_scopes=("hr_private",),
        ),
    )


def test_sse_frame_uses_protocol_id_type_and_json_envelope():
    from app.talent_run_api import encode_sse

    event = RunEvent(
        event_id="run-1:7",
        sequence=7,
        type="step.completed",
        run_id="run-1",
        timestamp="2026-09-27T10:00:00+00:00",
        data={"title": "理解人才要求"},
    )

    frame = encode_sse(event)

    assert frame.startswith("id: run-1:7\nevent: step.completed\ndata: ")
    assert frame.endswith("\n\n")
    payload = json.loads(frame.split("data: ", 1)[1])
    assert payload["sequence"] == 7
    assert payload["schema_version"] == "1.0"


def test_sse_endpoint_does_not_expose_replay_cursor_parameters():
    app = create_app(talent_run_manager=_job_selection_manager())

    operation = app.openapi()["paths"]["/api/runs/{run_id}/events"]["get"]
    parameter_names = {parameter["name"] for parameter in operation["parameters"]}

    assert "after_sequence" not in parameter_names
    assert "last-event-id" not in {name.lower() for name in parameter_names}


def test_create_run_returns_stream_location_and_cancel_is_idempotent():
    app = create_app(talent_run_manager=_job_selection_manager())
    with TestClient(app) as client:
        created = client.post(
            "/api/runs",
            json={"message": "筛选有企业知识库经验的候选人"},
        )
        assert created.status_code == 201
        body = created.json()
        assert body["events_url"] == f"/api/runs/{body['run_id']}/events"

        cancelled = client.delete(f"/api/runs/{body['run_id']}")
        repeated = client.delete(f"/api/runs/{body['run_id']}")

        assert cancelled.status_code == 200
        assert repeated.status_code == 200
        assert repeated.json()["status"] == "cancelled"


def test_resume_rejects_unknown_choice():
    app = create_app(talent_run_manager=_job_selection_manager())
    with TestClient(app) as client:
        created = client.post(
            "/api/runs",
            json={"message": "高级 AI 应用工程师"},
        ).json()
        run_id = created["run_id"]

        for _ in range(100):
            if app.state.talent_run_manager.get_run(run_id).status == "waiting_input":
                break
            time.sleep(0.001)

        response = client.post(
            f"/api/runs/{run_id}/resume",
            json={"value": "UNKNOWN"},
        )

        assert response.status_code == 409
        assert response.json()["detail"] == "请选择有效的岗位"
