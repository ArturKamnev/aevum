import { useRef, type ReactNode } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import type { Project, Task, ThemeMode, ViewId } from "../types";

gsap.registerPlugin(useGSAP);

interface AppShellProps {
  activeView: ViewId;
  setActiveView: (view: ViewId) => void;
  projects: Project[];
  tasks: Task[];
  theme: ThemeMode;
  onNewTask: () => void;
  onOpenCommandPalette: () => void;
  onToggleTheme: () => void;
  children: ReactNode;
}

export function AppShell({
  activeView,
  setActiveView,
  projects,
  tasks,
  theme,
  onNewTask,
  onOpenCommandPalette,
  onToggleTheme,
  children,
}: AppShellProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    const root = contentRef.current;
    if (!root) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const view = root.querySelector(".motion-view");
    if (!view) return;

    if (reduceMotion) {
      gsap.set(view, { autoAlpha: 1, y: 0, scale: 1 });
      return;
    }

    const revealItems = gsap.utils
      .toArray<HTMLElement>(
        [
          ".dashboard-hero",
          ".dashboard-panel",
          ".task-toolbar",
          ".task-card",
          ".upcoming-day",
          ".timeline-day",
          ".project-card",
          ".project-empty-panel",
          ".inbox-strip",
          ".assistant-hero-title",
          ".composer-container",
          ".chat-message",
          ".assistant-task-preview",
          ".daily-dial-panel",
          ".daily-detail-panel",
          ".unscheduled-panel",
          ".settings-section",
        ].join(", "),
        root,
      )
      .slice(0, 16);

    const timeline = gsap.timeline({ defaults: { ease: "power3.out", overwrite: "auto" } });
    timeline.fromTo(view, { autoAlpha: 0, y: 10, scale: 0.996 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.26 });
    if (revealItems.length) {
      timeline.fromTo(
        revealItems,
        { autoAlpha: 0, y: 8 },
        { autoAlpha: 1, y: 0, duration: 0.24, stagger: 0.018, clearProps: "opacity,visibility,transform" },
        "-=0.12",
      );
    }
  }, { dependencies: [activeView], scope: contentRef, revertOnUpdate: true });

  return (
    <div className="app-shell">
      <Sidebar activeView={activeView} setActiveView={setActiveView} projects={projects} tasks={tasks} />
      <main className="main-area">
        <TopBar
          activeView={activeView}
          theme={theme}
          onNewTask={onNewTask}
          onOpenCommandPalette={onOpenCommandPalette}
          onToggleTheme={onToggleTheme}
        />
        <div className="content-area" ref={contentRef}>
          <div className="motion-view" key={activeView}>
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
