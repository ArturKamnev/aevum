import {
  Bot,
  CalendarDays,
  ChartNoAxesGantt,
  CheckSquare,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import type { ViewId } from "../types";

interface Command {
  id: string;
  title: string;
  description: string;
  icon: typeof Search;
  run: () => void;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  setActiveView: (view: ViewId) => void;
  onToggleTheme: () => void;
  onAddStarterTask: () => void;
}

export function CommandPalette({ isOpen, onClose, setActiveView, onToggleTheme, onAddStarterTask }: CommandPaletteProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [shouldRender, setShouldRender] = useState(isOpen);
  const [isClosing, setIsClosing] = useState(false);

  const commands = useMemo<Command[]>(
    () => [
      {
        id: "add-task",
        title: t("command.addTask"),
        description: t("command.addTaskDescription"),
        icon: Plus,
        run: onAddStarterTask,
      },
      {
        id: "search",
        title: t("command.searchTasks"),
        description: t("command.searchDescription"),
        icon: Search,
        run: () => setActiveView("today"),
      },
      {
        id: "open-projects",
        title: t("command.openProject"),
        description: t("command.openProjectDescription"),
        icon: CheckSquare,
        run: () => setActiveView("projects"),
      },
      {
        id: "plan-day",
        title: t("command.planDay"),
        description: t("command.planDayDescription"),
        icon: Bot,
        run: () => setActiveView("assistant"),
      },
      {
        id: "toggle-theme",
        title: t("command.toggleTheme"),
        description: t("command.toggleThemeDescription"),
        icon: Moon,
        run: onToggleTheme,
      },
      {
        id: "calendar",
        title: t("command.goCalendar"),
        description: t("command.goCalendarDescription"),
        icon: CalendarDays,
        run: () => setActiveView("calendar"),
      },
      {
        id: "visualization",
        title: t("command.goVisualization"),
        description: t("command.goVisualizationDescription"),
        icon: ChartNoAxesGantt,
        run: () => setActiveView("visualization"),
      },
      {
        id: "settings",
        title: t("command.goSettings"),
        description: t("command.goSettingsDescription"),
        icon: Settings,
        run: () => setActiveView("settings"),
      },
    ],
    [onAddStarterTask, onToggleTheme, setActiveView, t],
  );

  const filteredCommands = commands.filter((command) => {
    const value = `${command.title} ${command.description}`.toLowerCase();
    return value.includes(query.toLowerCase());
  });

  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
      setIsClosing(false);
      return;
    }

    if (!shouldRender) return;
    setIsClosing(true);
    const timer = window.setTimeout(() => {
      setShouldRender(false);
      setIsClosing(false);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [isOpen, shouldRender]);

  useEffect(() => {
    if (!isOpen) return;
    setQuery("");
    setActiveIndex(0);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((index) => Math.min(index + 1, filteredCommands.length - 1));
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((index) => Math.max(index - 1, 0));
      }
      if (event.key === "Enter") {
        const command = filteredCommands[activeIndex];
        if (command) {
          command.run();
          onClose();
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeIndex, filteredCommands, isOpen, onClose]);

  if (!shouldRender) return null;

  return (
    <div className={`command-overlay ${isClosing ? "command-overlay--closing" : ""}`} role="presentation" onMouseDown={onClose}>
      <div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(event) => event.stopPropagation()}>
        <div className="command-palette__search">
          <Search size={18} />
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            placeholder={t("command.searchPlaceholder")}
          />
          <Sun size={16} aria-hidden="true" />
        </div>
        <div className="command-list">
          {filteredCommands.length === 0 ? (
            <div className="command-empty">{t("command.empty")}</div>
          ) : (
            filteredCommands.map((command, index) => {
              const Icon = command.icon;
              return (
                <button
                  className={`command-item ${index === activeIndex ? "command-item--active" : ""}`}
                  key={command.id}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => {
                    command.run();
                    onClose();
                  }}
                >
                  <span className="command-item__icon">
                    <Icon size={17} />
                  </span>
                  <span>
                    <strong>{command.title}</strong>
                    <small>{command.description}</small>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
