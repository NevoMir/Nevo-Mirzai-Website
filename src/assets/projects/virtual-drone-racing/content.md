# Virtual Drone Racing
_EPFL Crazyflie Practical • 2025_

<!-- ![Cover](cover/cover.png) -->
<!-- <video src="cover/cover.mp4" controls autoplay muted loop playsinline></video> -->

## Overview
This course project teaches students how to program a Crazyflie to race through randomly placed gates as fast as possible. The work is split into an individual **simulation task** (Webots) and a group **hardware transfer** task on the real drones.

- Lap 1 requires **gate detection** with onboard computer vision.
- Laps 2 and 3 reuse the detected gate locations for an all-out speed run.
- The full grade is an average of simulation + hardware performance.

## Key Deliverables
- Webots controller that takes off, detects 5 gates arranged in circular sectors, logs their position, and finishes three laps under 240 seconds.
- Detection, planning, and control stack that can be ported to the real Crazyflie (PID tuning, ROS2 tooling, deployment scripts).
- Presentation + video demo of the final autonomous run.

## Highlights
- Built perception pipeline using OpenCV to localize unknown gates during the first lap.
- Implemented lap-aware planner that reuses gate map to reduce lap time while respecting the clockwise order.
- Tuned on-board PID and motor mixing to maintain stability despite aggressive trajectories.
- Coordinated hardware testing sessions, ensuring best-of-three trials counted toward grading.

## Timeline
| Week | Focus |
|------|-------|
| 6-9  | Simulation development & Q&A, submission April 29 |
| 10   | Hardware introduction, pick up Crazyflie |
| 11-14| Hardware tuning, testing runs, final presentation |

## Media (to add)
- Simulation demo (`sim_2025.gif`)
- Real drone run footage
- System diagrams (`arc_simulation.png`, `sim2real.png`)
