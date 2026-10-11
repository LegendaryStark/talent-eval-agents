from langchain_community.embeddings import DashScopeEmbeddings
from langchain_openai import ChatOpenAI

from app.config import Settings, get_settings

def _build_chat_model(model: str, *, temperature: float, settings: Settings) -> ChatOpenAI:
    return ChatOpenAI(
        model=model,
        api_key=settings.dashscope_api_key,
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        temperature=None if "kimi" in model else temperature,
        extra_body={"enable_thinking": False},
    )


def get_chat_model(model_name: str | None = None, temperature: float = 0.2, settings: Settings | None = None) -> ChatOpenAI | None:
    value = settings or get_settings()
    if not value.dashscope_api_key or value.dashscope_api_key == "请用户自行填写":
        return None
    return _build_chat_model(model_name or value.chat_model, temperature=temperature, settings=value)


def get_embedding_model(settings: Settings | None = None) -> DashScopeEmbeddings | None:
    value = settings or get_settings()
    if not value.dashscope_api_key or value.dashscope_api_key == "请用户自行填写":
        return None
    return DashScopeEmbeddings(model=value.embedding_model, dashscope_api_key=value.dashscope_api_key)

if __name__ == "__main__":
    model = get_chat_model()
    # res = model.invoke(
    #         [("user", "你是谁？")]
    #     )
    from app.talent_evaluation_dispatch import EvaluationDimensionPlan, DIMENSION_GENERATOR_PROMPT

    res = model.with_structured_output(EvaluationDimensionPlan).invoke(
                [
                    ("system", DIMENSION_GENERATOR_PROMPT),
                    ("user", "你好"),
                ]
            )
    print(res)