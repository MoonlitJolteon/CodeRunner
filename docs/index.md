---
slug: /
sidebar_position: 1
title: Overview
---

# CodeRunner

import useBaseUrl from '@docusaurus/useBaseUrl';

CodeRunner is a self-hosted, browser-based IDE for teaching FRC robot programming. Students can open a web page, log in, write Java in a real VS Code editor, simulate their robot, inspect telemetry in AdvantageScope, and edit PathPlanner files. There is nothing to install on a student's machine and no per-device setup to maintain. Everything runs on a machine you control and is delivered through the browser.

{/* TODO(pathplanner-docs): Record a new overview showing both tool tabs. */}
<video
  autoPlay
  loop
  muted
  playsInline
  style={{
    width: '100%',
    height: 'auto',
    display: 'block',
    margin: '1.5rem 0',
    borderRadius: '8px',
    border: '1px solid var(--ifm-color-emphasis-200)',
    boxShadow: 'var(--ifm-global-shadow-lw)',
  }}
>
  <source src={useBaseUrl('/img/screenshots/hero-overview.mp4')} type="video/mp4" />
</video>

## How to use CodeRunner

1. Click **Switch project** and load a lesson or import a team project.
2. Follow the lesson instructions or open the files you want to edit.
3. Click **Start** in the Driver Station at the bottom of the page.
4. When robot code and communications are ready, choose a mode and click **Enable**.
5. Use the **AdvantageScope** and **PathPlanner** tabs to inspect telemetry or edit paths.

Use CodeRunner's **Start**, **Debug**, and **Build** controls for robot projects, not the WPILib extension's simulation, debugging, or build commands. Console lessons are the exception: run those with the editor's ▷ button.

[Read the short student guide →](./using-coderunner.md)

## What students get

- **A real VS Code editor in the browser.** Each student works in VSCodium with the Java and WPILib extensions already installed, so they get auto-import, code completion, Ctrl-click into library classes, and inline diagnostics, the same tooling a mentor would use locally.
- **An isolated workspace per student.** Every student gets their own Docker container, so one person's broken build or runaway process never affects anyone else.
- **One-click simulation with a built-in Driver Station.** Clicking **Start** builds the project and starts a WPILib simulation. The Driver Station UI lets students enable the robot, switch modes, and drive with a gamepad.
- **Integrated robot tools.** Robot data streams into AdvantageScope, while PathPlanner edits files in the current project. Both are available beside the editor without a separate install.

## Lessons and team projects

CodeRunner ships with lesson modules that take beginners from plain Java all the way up to a complete WPILib robot, one step at a time. Students choose a lesson from the editor and their workspace fills in with the starting code. When a team is ready to work on its own robot, they can instead import a public GitHub robot project and keep working against their real codebase.

## Self-hosted and modest to run

CodeRunner is designed to run on hardware you already have: a spare classroom machine during the season, or a small cloud VM when you want students to reach it from home. You decide who can log in, and student data lives on your own disk.

## Video walkthrough

A recorded overview of CodeRunner, with some basic demos and high-level info on how it works.

<div
  style={{
    position: 'relative',
    paddingBottom: '56.25%',
    height: 0,
    margin: '1.5rem 0',
    borderRadius: '8px',
    overflow: 'hidden',
    border: '1px solid var(--ifm-color-emphasis-200)',
    boxShadow: 'var(--ifm-global-shadow-lw)',
  }}
>
  <iframe
    src="https://www.youtube-nocookie.com/embed/xnYzocVwkq8"
    title="CodeRunner overview"
    loading="lazy"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    allowFullScreen
    style={{
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      border: 0,
    }}
  />
</div>

## Next steps

- [Using CodeRunner](./using-coderunner.md): load a project, edit code, and run a simulation.
- [Quick Start (Installation)](./quick-start.md): get a demo instance running locally in a few commands.
- [About CodeRunner](./about/architecture.md): how the pieces fit together.
- [Deploying](./deploying/overview.md): set up a real, multi-user instance with login.
- [Lessons](./lessons/overview.md): what the bundled lessons cover and how to author your own.
