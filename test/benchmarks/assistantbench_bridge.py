import json
import sys

from browsergym.assistantbench.evaluation.evaluator import question_scorer
from browsergym.assistantbench.task import gold_answers_dev, ids_dev, tasks_dev


def task_record(task_id: str) -> dict:
    if task_id not in tasks_dev:
        raise KeyError(f"unknown AssistantBench validation task {task_id}")
    return {
        "id": task_id,
        "benchmarkId": ids_dev[task_id],
        "intent": tasks_dev[task_id],
        "startUrl": "https://google.com/",
    }


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else "doctor"
    if command == "doctor":
        output = {
            "suite": "assistantbench-validation",
            "tasks": len(tasks_dev),
            "evaluator": "browsergym.assistantbench.evaluation.evaluator.question_scorer",
        }
    elif command == "list":
        output = [task_record(task_id) for task_id in sorted(tasks_dev)]
    elif command == "task":
        output = task_record(sys.argv[2])
    elif command == "evaluate":
        task_id = sys.argv[2]
        prediction = sys.argv[3]
        score, has_answer = question_scorer(prediction, gold_answers_dev[task_id])
        output = {
            **task_record(task_id),
            "score": float(score),
            "hasAnswer": bool(has_answer),
            "evaluator": "browsergym.assistantbench.evaluation.evaluator.question_scorer",
        }
    else:
        raise ValueError(f"unknown command {command}")
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
