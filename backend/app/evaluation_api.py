"""Raw Cases and problem signals in the existing course-demo application."""
from typing import Literal
from uuid import UUID
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select, exists
from app.database import SessionLocal
from app.evaluation_case import EvaluationModule
from app.models import EvaluationCaseRecord as Case, EvaluationFeedbackRecord as Feedback, TalentRunRecord

router = APIRouter(prefix='/api/evaluation', tags=['evaluation'])


class FeedbackInput(BaseModel):
    source_run_id: str = Field(min_length=1, max_length=64)
    case_id: UUID | None = None
    feedback_scope: Literal['module', 'run']
    note: str = Field(default='', max_length=2000)

    @model_validator(mode='after')
    def check_scope(self):
        if (self.feedback_scope == 'module') != (self.case_id is not None):
            raise ValueError('模块反馈必须引用 Case，报告反馈仅关联 Run')
        return self


def feedback_json(row):
    return dict(feedback_id=str(row.id), source_run_id=row.source_run_id,
                case_id=str(row.case_id) if row.case_id else None,
                feedback_scope=row.feedback_scope, note=row.note, created_at=row.created_at.isoformat())


@router.post('/feedback', status_code=201)
def create_feedback(payload: FeedbackInput):
    with SessionLocal() as db:
        if db.get(TalentRunRecord, payload.source_run_id) is None:
            raise HTTPException(404, 'Run 不存在')
        if payload.case_id:
            case = db.get(Case, payload.case_id)
            if case is None or case.source_run_id != payload.source_run_id:
                raise HTTPException(404, '该 Run 下的 Case 不存在')
        row = Feedback(**payload.model_dump())
        db.add(row)
        db.commit()
        db.refresh(row)
        return feedback_json(row)


@router.get('/cases')
def list_cases(source_run_id: str | None = None, module_key: EvaluationModule | None = None,
               status: Literal['succeeded', 'failed'] | None = None,
               has_feedback: bool | None = None, offset: int = Query(0, ge=0),
               limit: int = Query(100, ge=1, le=200)):
    with SessionLocal() as db:
        direct = exists(select(Feedback.id).where(Feedback.case_id == Case.id))
        run_signal = exists(select(Feedback.id).where(Feedback.source_run_id == Case.source_run_id,
                                                      Feedback.feedback_scope == 'run'))
        stmt = select(Case, direct.label('has_feedback'), run_signal.label('run_has_feedback'))
        if source_run_id:
            stmt = stmt.where(Case.source_run_id == source_run_id)
        if module_key:
            stmt = stmt.where(Case.module_key == module_key.value)
        if status:
            stmt = stmt.where(Case.status == status)
        if has_feedback is not None:
            stmt = stmt.where(direct == has_feedback)
        rows = db.execute(stmt.order_by(Case.created_at.desc(), Case.id).offset(offset).limit(limit + 1)).all()
        return {'has_more': len(rows) > limit, 'items': [dict(
            case_id=str(row.id), source_run_id=row.source_run_id, conversation_id=row.conversation_id,
            turn_no=row.turn_no, module_key=row.module_key, invocation_no=row.invocation_no,
            status=row.status, error_code=row.error_code, created_at=row.created_at.isoformat(),
            identity={k: row.input_payload[k] for k in ('candidate_id', 'dimension_number', 'requirement_id', 'attempt') if k in row.input_payload},
            has_feedback=signal, run_has_feedback=run_signal_value,
        ) for row, signal, run_signal_value in rows[:limit]]}


@router.get('/cases/{case_id}')
def get_case(case_id: UUID):
    with SessionLocal() as db:
        row = db.get(Case, case_id)
        if row is None:
            raise HTTPException(404, 'Case 不存在')
        feedback = db.scalars(select(Feedback).where(Feedback.source_run_id == row.source_run_id).order_by(Feedback.created_at)).all()
        return {**{column.name: getattr(row, column.name) for column in Case.__table__.columns},
                'feedback': [feedback_json(item) for item in feedback if item.case_id == row.id or item.feedback_scope == 'run']}
