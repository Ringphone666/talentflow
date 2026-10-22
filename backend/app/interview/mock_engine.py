"""测试环境（TALENTFLOW_TEXT_MODE=mock）使用的固定题目、回答和生成结果；生产环境不会调用。"""
import copy
import re

from .standards import DIMENSIONS, DISCLAIMER, RUBRIC, filter_sensitive


QUESTIONS = [
    ("岗位专业能力", "请结合一个具体事例，说明你如何识别并处理生产或学习任务中的质量异常。"),
    ("逻辑思维", "面对产量、质量和安全三项要求同时出现冲突时，你会如何分析并确定处理顺序？"),
    ("沟通表达", "请讲述一次你需要向不同角色说明复杂问题并达成共识的经历。"),
    ("抗压能力", "请描述一次时间紧、任务重的经历，你如何保持规范执行并寻求支持？"),
    ("职业稳定性", "这类生产储备岗位吸引你的具体原因是什么？你准备如何完成前六个月的学习适应？"),
    ("企业价值观契合度", "请分享一次你坚持如实记录、主动担责或协作改进的经历。"),
]

# 业务人力资源部试点题目。与旧的制造岗位题目并存，按招聘批次和岗位固定快照，
# 这样同一批次的候选人仍然使用完全一致的主体问题。
HR_QUESTIONS = [
    ("岗位专业能力", "请结合一次招聘、人员调配或人力资源规划经历，说明你如何分析需求并形成可执行的方案。"),
    ("逻辑思维", "当人员需求、预算和到岗时间发生冲突时，你会如何拆解问题、比较方案并向负责人汇报？"),
    ("沟通表达", "请讲述一次你需要向候选人、业务部门和管理者分别沟通同一事项的经历，你如何确保信息一致？"),
    ("抗压能力", "请描述一次招聘或人事事务集中发生、时间紧张的经历，你如何保留关键审核步骤并按时完成？"),
    ("职业稳定性", "你为什么选择人力资源工作？请说明你未来一到三年的学习计划和希望形成的专业能力。"),
    ("企业价值观契合度", "请分享一次你在保密、原则、服务或团队协作之间遇到取舍时的具体经历和处理结果。"),
]


def build_scoring_advice(job: dict):
    """根据岗位资料生成可审核的岗位化评分卡建议，不直接覆盖岗位资料。"""
    name = job.get("name", "")
    text = " ".join(str(job.get(key, "")) for key in ("name", "duties", "requirements", "professional_requirements"))
    if "人力资源" in text or "招聘" in text or "薪酬" in text or "劳动关系" in text:
        weights = [30, 15, 20, 10, 10, 15]
        profile = "人力资源岗位重点考察专业流程、沟通协调和综合判断，同时保留保密、原则与服务要求。"
    elif "生产" in text or "制造" in text or "质量" in text or "安全" in text:
        weights = [30, 20, 15, 15, 10, 10]
        profile = "生产类岗位重点考察现场专业能力、逻辑判断、质量安全底线和异常处置。"
    elif "监督" in text or "审计" in text or "合规" in text:
        weights = [25, 25, 15, 15, 10, 10]
        profile = "监督和合规类岗位重点考察事实分析、风险识别、沟通协调和原则性。"
    elif "管理" in text or "负责人" in text:
        weights = [25, 20, 20, 15, 10, 10]
        profile = "管理类岗位重点考察专业判断、结构化思考、沟通影响和压力下的决策。"
    else:
        weights = [25, 20, 15, 15, 10, 15]
        profile = "建议从岗位专业要求、问题分析、沟通、压力应对、稳定性和价值观六个方面综合观察。"
    job_model = {item.get("dimension"): item for item in job.get("competency_model", []) if isinstance(item, dict)}
    criteria = []
    for index, (dimension, definition, _) in enumerate(DIMENSIONS):
        source = job_model.get(dimension, {})
        behavior = source.get("behavior") or definition
        criteria.append({
            "dimension": dimension,
            "suggested_weight": weights[index],
            "definition": behavior,
            "levels": {
                "0": "已作答但答非所问，仅问候、测试口令或无关内容；无录音、空白、单纯超时不评分",
                "1": "回应了本题但未展示基本方法，或相关做法明显不符合岗位要求",
                "2": "只有概括性描述，能提供的行动和结果证据较少",
                "3": f"能在相关岗位场景中做到：{behavior[:48]}；提供一个基本完整事例",
                "4": f"能具体说明如何做到：{behavior[:48]}，并说明判断、行动和结果",
                "5": f"能在复杂场景中稳定做到：{behavior[:48]}，提供多个事例并复盘形成方法",
            },
            "evidence_focus": source.get("source_evaluation_basis") or ["岗位职责和回答中的可定位行为证据"],
        })
    return {
        "job_code": job.get("code"),
        "job_name": name,
        "total_weight": sum(weights),
        "rationale": profile,
        "criteria": criteria,
        "guardrails": [
            "建议必须由HR和业务面试官确认后才能作为正式评分卡",
            "没有回答证据时显示“证据不足”，不自动补齐正面或负面判断",
            "不得根据年龄、性别、地域、民族、宗教、婚育、健康等敏感属性评分",
            "举止仪表如需保留，只能由现场考官人工记录，AI不根据音视频推断",
        ],
        "status": "suggested",
        "provenance": "AI辅助生成，须人工复核",
    }

DEFAULT_TRANSCRIPTS = [
    "我先按检查表复核了记录，发现温度数据与现场读数不一致。我暂停交接，通知同组同事复测并向负责人说明，确认是传感器接触问题后补充了异常记录。",
    "我会先把安全作为不可突破的约束，再确认质量风险和交付影响，列出可选方案，与负责人确认后执行并保留记录。",
    "我先用流程图说明问题，再分别向操作同事和项目负责人解释影响，最后复述双方确认的行动和时间点。",
    "任务临时提前时，我重新排了优先级，把必须复核的步骤保留，能并行的工作分给同伴，并在预计延期前主动升级。",
    "我希望从现场标准和基础流程学起。前两个月熟悉安全与记录，三到四个月能独立完成基础任务，之后通过复盘补齐薄弱环节。",
    "我曾发现自己录入的数据有一处错误，当天主动说明并修正，同时把容易混淆的字段做成核对清单供小组使用。",
]

FOLLOWUPS = [
    "你提到复核记录，请具体说明当时使用了什么判断标准？",
    "在你列出的方案中，哪项信息最可能改变你的优先级？",
    "对方最初不认同的点是什么，你如何确认最终共识？",
    "如果无法获得额外人手，你会删减哪些工作，又会保留哪些底线？",
    "你将用什么可观察的结果判断自己已经适应岗位？",
    "这次经历之后，你怎样验证清单确实减少了错误？",
]

DEFAULT_FOLLOWUP_TRANSCRIPTS = [
    "当时我先对照检查表中的允许范围，再进行复测并请负责人共同确认，最后把异常原因和处理结果补充到记录中。",
    "如果安全风险或质量影响发生变化，我会立即调整优先级，并把调整依据同步给负责人后留存记录。",
    "对方最初担心影响进度，我用流程和数据说明风险，最后逐项确认负责人、完成时间和复核方式。",
    "无法增加人手时，我会压缩非关键沟通和可延期工作，但保留安全、质量复核和异常升级步骤。",
    "我会用能否独立完成基础任务、记录是否准确以及复盘问题是否减少来判断适应情况。",
    "我在后续任务中抽查了清单使用情况，并比较了修改前后的录入错误，确认同类错误有所减少。",
]

def generate_followup(sequence: int, transcript: str):
    clean = re.sub(r"\s+", "", transcript or "")
    clauses = [part for part in re.split(r"[。！？；]", clean) if part]
    focus = (clauses[0] if clauses else clean)[:34]
    if not focus:
        candidate = FOLLOWUPS[(sequence - 1) % len(FOLLOWUPS)]
        basis = "回答内容较少，使用本维度补充问题"
    else:
        prompts = [
            "请进一步说明当时使用的具体判断标准，以及你如何确认处理结果有效？",
            "请说明其中哪项信息最可能改变你的处理优先级，为什么？",
            "请补充对方最初不认同的具体内容，以及你如何确认最终达成共识？",
            "如果当时无法获得额外支持，你会保留哪些底线步骤，又会调整哪些工作？",
            "请说明你会用哪些可观察结果判断自己已经完成岗位适应？",
            "请补充你后来如何验证这项改进确实减少了同类错误？",
        ]
        candidate = f"你刚才提到“{focus}”。{prompts[(sequence - 1) % len(prompts)]}"
        basis = focus
    allowed, reason = filter_sensitive(candidate)
    return {"allowed": allowed, "reason": reason, "content": candidate, "basis": basis}


def build_report(candidate_name: str, answers: list[dict], score_profile: list[int] | None = None, job: dict | None = None):
    answer_map = {a["sequence"]: a for a in answers}
    scores = score_profile or [4, 4, 4, 4, 4, 4]
    evaluations = []
    for index, (name, definition, weight) in enumerate(DIMENSIONS, start=1):
        answer = answer_map.get(index)
        transcript = (answer or {}).get("transcript", "").strip()
        sufficient = len(transcript) >= 24
        evaluations.append({
            "dimension": name,
            "definition": definition,
            "weight": weight,
            "score": scores[index - 1] if sufficient else None,
            "level": f"{scores[index - 1]}级" if sufficient else "证据不足",
            "reason": f"回答给出了可定位的行动与处理过程：{transcript[:54]}" if sufficient else "当前回答未提供足够的具体行为、过程或结果，需在线下面试补充核实。",
            "answer_ids": [answer.get("answer_code")] if sufficient and answer else [],
            "evidence_excerpt": transcript[:90] if sufficient else "证据不足",
            "evidence_sufficiency": "充分" if len(transcript) >= 55 else ("部分" if sufficient else "不足"),
            "insufficient": not sufficient,
        })
    weighted = sum((e["score"] or 0) * e["weight"] for e in evaluations) / 5
    return {
        "disclaimer": DISCLAIMER,
        "candidate": candidate_name,
        "summary": f"{candidate_name}完成了{(job or {}).get('name', '第一阶段')}面试。纪要仅汇总回答中可定位的事实，不构成录用或淘汰结论。",
        "qa_records": copy.deepcopy(answers),
        "evaluations": evaluations,
        "match_analysis": {
            "score": round(weighted, 1),
            "matched": ["能够描述规范执行和异常升级", "表达中包含复核与协作意识"],
            "to_verify": ["需在线下核实长期岗位动机与现场适应计划"],
        },
        "risks": ["语音转写内容需人工核实准确性", "AI 评分只可作为人工初筛参考"],
        "offline_questions": ["请补充一个你独立处理现场异常的完整例子。", "如果标准与短期进度冲突，你如何沟通并留痕？"],
        "decision": None,
        "job_context": {"code": (job or {}).get("code"), "name": (job or {}).get("name"), "material_version": (job or {}).get("material_version")} if job else None,
    }
