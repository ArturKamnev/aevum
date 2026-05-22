import { Plus } from "lucide-react";
import { FormEvent, useState } from "react";
import { useI18n } from "../i18n";
import type { Project, TaskDraft } from "../types";
import { combineDateAndTime, getTodayISO } from "../utils/date";
import { defaultRepeat } from "../utils/recurrence";

interface QuickAddTaskProps {
  projects: Project[];
  onAddTask: (task: TaskDraft) => void;
}

export function QuickAddTask({ projects, onAddTask }: QuickAddTaskProps) {
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(getTodayISO());
  const [time, setTime] = useState("");
  const [durationMinutes, setDurationMinutes] = useState<number | null>(null);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;

    onAddTask({
      title: trimmedTitle,
      description: "",
      status: "active",
      scheduledAt: combineDateAndTime(date, time),
      projectId: projectId || projects[0]?.id || "workspace",
      durationMinutes,
      reminderMinutes: null,
      repeat: { ...defaultRepeat },
      nextRepeatAt: null,
      tags: [],
      subtasks: [],
    });
    setTitle("");
  }

  return (
    <form className="quick-add" onSubmit={handleSubmit}>
      <div className="quick-add__input">
        <Plus size={18} />
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t("task.quickPlaceholder")}
          aria-label={t("task.newTitle")}
        />
      </div>
      <select value={projectId} onChange={(event) => setProjectId(event.target.value)} aria-label={t("task.project")}>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      <input value={date} onChange={(event) => setDate(event.target.value)} onInput={(event) => setDate(event.currentTarget.value)} type="date" aria-label={t("task.date")} />
      <input value={time} onChange={(event) => setTime(event.target.value)} onInput={(event) => setTime(event.currentTarget.value)} type="time" aria-label={t("task.time")} />
      <select
        value={durationMinutes ?? ""}
        onChange={(event) => setDurationMinutes(event.target.value ? Number(event.target.value) : null)}
        aria-label={t("task.duration")}
      >
        <option value="">{t("task.noDuration")}</option>
        <option value="15">{t("task.duration15")}</option>
        <option value="30">{t("task.duration30")}</option>
        <option value="60">{t("task.duration60")}</option>
        <option value="120">{t("task.duration120")}</option>
      </select>
      <button className="button button--primary" type="submit">
        {t("task.add")}
      </button>
    </form>
  );
}
