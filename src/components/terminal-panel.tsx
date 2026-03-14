"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { apiFetch } from "@/lib/api-fetch";
import { useHaptics } from "@/hooks/use-haptics";
import { CloseIcon, PlusIcon, Spinner, StopIcon, TrashIcon } from "./icons";

interface TerminalInfo {
  id: string;
  cwd: string;
  running: boolean;
  exitCode: number | null;
  startedAt: number;
}

interface TerminalTab {
  id: string;
  label: string;
  running: boolean;
  exitCode: number | null;
}

interface TerminalPanelProps {
  open: boolean;
  onClose: () => void;
  workspace?: string;
  onCountChange?: (count: number) => void;
}

interface XtermEntry {
  term: Terminal;
  fit: FitAddon;
  opened: boolean;
  disposed: boolean;
}

const XTERM_THEME = {
  background: "#000000",
  foreground: "#e8e8e8",
  cursor: "#e8e8e8",
  cursorAccent: "#000000",
  selectionBackground: "#ffffff30",
};

function cwdLabel(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() || "~";
}

export function TerminalPanel({ open, onClose, workspace, onCountChange }: TerminalPanelProps) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [spawning, setSpawning] = useState(false);
  const eventSourcesRef = useRef<Map<string, EventSource>>(new Map());
  const xtermsRef = useRef<Map<string, XtermEntry>>(new Map());
  const containerRefsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const haptics = useHaptics();
  const loadedRef = useRef(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const xtermCtorRef = useRef<typeof Terminal | null>(null);
  const fitCtorRef = useRef<typeof FitAddon | null>(null);
  const linksCtorRef = useRef<typeof WebLinksAddon | null>(null);
  const [xtermReady, setXtermReady] = useState(false);

  useEffect(() => { onCountChange?.(tabs.length); }, [tabs.length, onCountChange]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      import("@xterm/xterm").then((m) => m.Terminal),
      import("@xterm/addon-fit").then((m) => m.FitAddon),
      import("@xterm/addon-web-links").then((m) => m.WebLinksAddon),
    ]).then(([TermCtor, FitCtor, LinksCtor]) => {
      if (cancelled) return;
      xtermCtorRef.current = TermCtor;
      fitCtorRef.current = FitCtor;
      linksCtorRef.current = LinksCtor;
      setXtermReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  const getOrCreateXterm = useCallback((id: string): XtermEntry | null => {
    const existing = xtermsRef.current.get(id);
    if (existing && !existing.disposed) return existing;

    const TermCtor = xtermCtorRef.current;
    const FitCtor = fitCtorRef.current;
    const LinksCtor = linksCtorRef.current;
    if (!TermCtor || !FitCtor) return null;

    const term = new TermCtor({
      theme: XTERM_THEME,
      fontSize: 13,
      fontFamily: '"SF Mono", "Fira Code", Menlo, Consolas, monospace',
      cursorBlink: true,
      scrollback: 5000,
      convertEol: true,
      disableStdin: true,
    });
    const fit = new FitCtor();
    term.loadAddon(fit);
    if (LinksCtor) {
      term.loadAddon(new LinksCtor((_, uri) => window.open(uri, "_blank")));
    }

    const entry: XtermEntry = { term, fit, opened: false, disposed: false };
    xtermsRef.current.set(id, entry);
    return entry;
  }, []);

  const tryOpenTerminal = useCallback((id: string) => {
    const entry = xtermsRef.current.get(id);
    const el = containerRefsRef.current.get(id);
    if (!entry || !el || entry.opened || entry.disposed) return;
    entry.term.open(el);
    entry.opened = true;
    requestAnimationFrame(() => {
      try { entry.fit.fit(); } catch { /* not visible yet */ }
    });
  }, []);

  const connectStream = useCallback((id: string) => {
    if (eventSourcesRef.current.has(id)) return;
    const entry = getOrCreateXterm(id);
    if (!entry) return;

    const es = new EventSource(`/api/terminal/stream?id=${id}`);
    eventSourcesRef.current.set(id, es);

    es.addEventListener("connected", (e) => {
      const data = JSON.parse(e.data);
      if (data.output) entry.term.write(data.output);
      setTabs((prev) =>
        prev.map((t) => t.id === id ? { ...t, running: data.running, exitCode: data.exitCode } : t),
      );
    });

    es.addEventListener("output", (e) => {
      const data = JSON.parse(e.data);
      if (data.data) entry.term.write(data.data);
      setTabs((prev) =>
        prev.map((t) => t.id === id ? { ...t, running: data.running, exitCode: data.exitCode } : t),
      );
    });

    es.onerror = () => {
      es.close();
      eventSourcesRef.current.delete(id);
    };
  }, [getOrCreateXterm]);

  const prevWorkspaceRef = useRef(workspace);

  useEffect(() => {
    if (prevWorkspaceRef.current !== workspace) {
      prevWorkspaceRef.current = workspace;
      loadedRef.current = false;

      for (const es of eventSourcesRef.current.values()) es.close();
      eventSourcesRef.current.clear();
      for (const entry of xtermsRef.current.values()) {
        entry.disposed = true;
        entry.term.dispose();
      }
      xtermsRef.current.clear();
      containerRefsRef.current.clear();
      setTabs([]);
      setActiveTab(null);
      setInput("");
    }
  }, [workspace]);

  useEffect(() => {
    if (!open || !xtermReady) return;
    if (loadedRef.current) return;
    loadedRef.current = true;

    apiFetch("/api/terminal")
      .then((r) => r.json())
      .then((data) => {
        const all: TerminalInfo[] = data.terminals || [];
        const existing = workspace ? all.filter((t) => t.cwd === workspace) : all;
        if (existing.length === 0) return;
        const newTabs = existing.map((t) => ({
          id: t.id,
          label: cwdLabel(t.cwd),
          running: t.running,
          exitCode: t.exitCode,
        }));
        setTabs(newTabs);
        setActiveTab(newTabs[0].id);
        for (const t of newTabs) connectStream(t.id);
      })
      .catch(() => {});
  }, [open, xtermReady, connectStream, workspace]);

  useEffect(() => {
    return () => {
      for (const es of eventSourcesRef.current.values()) es.close();
      eventSourcesRef.current.clear();
      for (const entry of xtermsRef.current.values()) {
        entry.disposed = true;
        entry.term.dispose();
      }
      xtermsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!open || !wrapperRef.current) return;
    const observer = new ResizeObserver(() => {
      if (!activeTab) return;
      const entry = xtermsRef.current.get(activeTab);
      if (entry?.opened && !entry.disposed) {
        try { entry.fit.fit(); } catch { /* ignore */ }
      }
    });
    observer.observe(wrapperRef.current);
    return () => observer.disconnect();
  }, [open, activeTab]);

  useEffect(() => {
    if (!xtermReady) return;
    for (const tab of tabs) tryOpenTerminal(tab.id);
  }, [tabs, xtermReady, tryOpenTerminal]);

  useEffect(() => {
    if (!activeTab) return;
    const entry = xtermsRef.current.get(activeTab);
    if (entry?.opened && !entry.disposed) {
      requestAnimationFrame(() => {
        try { entry.fit.fit(); } catch { /* ignore */ }
      });
    }
  }, [activeTab]);

  const current = tabs.find((t) => t.id === activeTab);
  const isRunning = current?.running ?? false;

  const cleanupTerminal = useCallback((id: string) => {
    const es = eventSourcesRef.current.get(id);
    if (es) { es.close(); eventSourcesRef.current.delete(id); }
    const entry = xtermsRef.current.get(id);
    if (entry) { entry.disposed = true; entry.term.dispose(); xtermsRef.current.delete(id); }
    containerRefsRef.current.delete(id);
    apiFetch("/api/terminal", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, remove: true }),
    }).catch(() => {});
  }, []);

  const handleNewShell = useCallback(async () => {
    setSpawning(true);
    try {
      const res = await apiFetch("/api/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: workspace }),
      });
      const data = await res.json();
      const label = cwdLabel(data.cwd || workspace || "~");
      const tab: TerminalTab = { id: data.id, label, running: true, exitCode: null };
      setTabs((prev) => [...prev, tab]);
      setActiveTab(data.id);
      connectStream(data.id);
      haptics.send();
      setTimeout(() => inputRef.current?.focus(), 50);
    } catch {
      haptics.error();
    } finally {
      setSpawning(false);
    }
  }, [workspace, connectStream, haptics]);

  const handleSendStdin = useCallback(async (text: string) => {
    if (!activeTab || !text) return;
    await apiFetch("/api/terminal/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: activeTab, data: text + "\n" }),
    }).catch(() => {});
    setInput("");
  }, [activeTab]);

  const handleSubmit = useCallback(() => {
    if (!current || !isRunning) return;
    handleSendStdin(input);
  }, [input, current, isRunning, handleSendStdin]);

  const handleCtrlC = useCallback(async () => {
    if (!activeTab) return;
    await apiFetch("/api/terminal/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: activeTab, data: "\x03" }),
    }).catch(() => {});
    haptics.tap();
  }, [activeTab, haptics]);

  const handleKill = useCallback(async (id: string) => {
    haptics.warn();
    await apiFetch("/api/terminal", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => {});
  }, [haptics]);

  const handleRemove = useCallback((id: string) => {
    cleanupTerminal(id);
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (activeTab === id) setActiveTab(next[0]?.id ?? null);
      return next;
    });
    haptics.tap();
  }, [activeTab, haptics, cleanupTerminal]);

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/60" aria-hidden="true" onClick={onClose} />
      <div className="fixed inset-0 z-50 bg-bg-elevated flex flex-col sm:inset-auto sm:top-0 sm:right-0 sm:h-full sm:w-[380px] sm:border-l sm:border-border">

        {/* Header */}
        <div className="flex items-center justify-between h-11 px-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[13px] font-medium text-text-secondary">Terminal</span>
            {tabs.length > 0 && (
              <span className="text-[10px] text-text-muted">{tabs.length}</span>
            )}
          </div>
          <div className="flex items-center gap-0.5">
            <button
              onClick={handleNewShell}
              disabled={spawning}
              className="p-1.5 rounded-md transition-colors text-text-muted hover:text-text-secondary hover:bg-bg-hover disabled:opacity-40"
              aria-label="New terminal"
            >
              {spawning ? <Spinner className="w-3.5 h-3.5" /> : <PlusIcon size={13} />}
            </button>
            <button
              onClick={onClose}
              aria-label="Close"
              className="p-1.5 rounded-md hover:bg-bg-hover text-text-muted hover:text-text-secondary transition-colors"
            >
              <CloseIcon size={13} />
            </button>
          </div>
        </div>

        {/* Tabs */}
        {tabs.length > 0 && (
          <div className="shrink-0 flex items-center gap-0.5 px-2 py-1 border-b border-border overflow-x-auto">
            {tabs.map((t, i) => (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={`group flex items-center gap-1.5 pl-2 pr-1 py-1.5 rounded-md text-[11px] font-mono transition-colors shrink-0 max-w-[150px] ${
                  t.id === activeTab
                    ? "bg-bg-active text-text"
                    : "text-text-muted hover:text-text-secondary hover:bg-bg-hover"
                }`}
              >
                <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${t.running ? "bg-success" : t.exitCode === 0 ? "bg-text-muted/30" : "bg-error/60"}`} />
                <span className="truncate">{t.label}{tabs.filter((x) => x.label === t.label).length > 1 ? ` ${i + 1}` : ""}</span>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); if (t.running) handleKill(t.id); else handleRemove(t.id); }}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); if (t.running) handleKill(t.id); else handleRemove(t.id); } }}
                  className="shrink-0 ml-0.5 p-1 rounded opacity-40 hover:opacity-100 active:opacity-100 hover:bg-bg-active transition-opacity"
                >
                  <CloseIcon size={9} />
                </span>
              </button>
            ))}
          </div>
        )}

        {/* xterm area */}
        <div ref={wrapperRef} className="flex-1 relative bg-bg overflow-hidden">
          {tabs.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center">
              <button
                onClick={handleNewShell}
                disabled={spawning}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] text-text-muted hover:text-text-secondary bg-bg-surface hover:bg-bg-hover transition-colors disabled:opacity-40"
              >
                {spawning ? <Spinner className="w-3.5 h-3.5" /> : <PlusIcon size={13} />}
                New terminal
              </button>
            </div>
          )}
          {tabs.map((t) => (
            <div
              key={t.id}
              ref={(el) => {
                if (el) {
                  containerRefsRef.current.set(t.id, el);
                  tryOpenTerminal(t.id);
                }
              }}
              className="absolute inset-0"
              style={{ display: t.id === activeTab ? "block" : "none" }}
            />
          ))}
        </div>

        {/* Bottom bar */}
        {current && (
          <div className="shrink-0 border-t border-border bg-bg-elevated">
            {!isRunning && (
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-border">
                <span className="text-[11px] text-text-muted">
                  exited{current.exitCode !== 0 && current.exitCode !== null ? ` (${current.exitCode})` : ""}
                </span>
                <button
                  onClick={() => handleRemove(current.id)}
                  className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors"
                >
                  <TrashIcon size={10} />
                  Remove
                </button>
              </div>
            )}

            {isRunning && (
              <form
                onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}
                className="flex items-center gap-2 px-3 py-2.5"
              >
                <span className="text-[13px] font-mono shrink-0 text-text-muted">{">"}</span>
                <input
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Type a command..."
                  className="flex-1 min-w-0 bg-transparent text-[13px] font-mono text-text placeholder:text-text-muted/50 focus:outline-none"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={handleCtrlC}
                  className="shrink-0 px-2 py-1 rounded-md text-[11px] font-mono text-error/60 hover:text-error hover:bg-error/10 transition-colors"
                >
                  ^C
                </button>
                <button
                  type="button"
                  onClick={() => handleKill(current.id)}
                  className="shrink-0 p-1.5 rounded-md text-error/50 hover:text-error hover:bg-error/10 transition-colors"
                  aria-label="Kill process"
                >
                  <StopIcon size={12} />
                </button>
              </form>
            )}
          </div>
        )}

      </div>
    </>
  );
}
