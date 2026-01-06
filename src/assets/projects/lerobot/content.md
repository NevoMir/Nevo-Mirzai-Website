# LeRobot

2025 • *I assembled a robotic arm and built a teleoperation system to teach it tasks through imitation learning.*

<video src="cover/cover.mp4" controls autoplay muted loop playsinline height="50vh"></video>

---

## Overview

## What I Built

I wanted to teach a robot to perform tasks just by showing it how.
To do this, I set up a **teleoperation system** with two robotic arms: a "leader" that I move by hand, and a "follower" that mirrors every movement in real-time.

I wrote a custom control stack on Ubuntu that maps the joint angles from the first arm to the second one with very low latency. This makes controlling the robot feel natural—almost like an extension of my own arm.

A lot of the complexity lived in the low-level details: **power sequencing, serial communication, USB permissions, and precise calibration**. Mastering these elements was crucial to ensuring reliable, real-time control.

---

## From Teleoperation to Autonomy

The goal of this setup is **Imitation Learning**.
By recording the camera feed and the motor commands while I perform a task (like picking up an object), I create a dataset of "expert demonstrations."

Each recording captures:
- What the robot sees (video frames)
- How it moves (motor commands)
- Its internal state

I can then use this data to train a neural network.

### Technical Approach: ACT Policy

To solve this, I utilized an **Action Chunking with Transformers (ACT)** policy. This architecture is effective because it mitigates the compounding errors typical in simple behavior cloning by predicting *sequences* of actions rather than single time-steps.

**The Pipeline:**

1.  **Vision Encoder:** A **ResNet-18** backbone extracts features from the **wrist-mounted camera**, which provides an egocentric view crucial for precision manipulation.
2.  **State Encoding:** These visual features are concatenated with the robot's current proprioception (joint angles).
3.  **Policy Network:** A **Transformer (CVAE-based)** processes this multimodal input to predict a "chunk" of future actions ($k$ steps). Because it uses a Variational Autoencoder, it learns a latent space of valid behaviors, allowing it to handle variability in human demonstrations.
4.  **Temporal Ensembling:** During inference, overlapping action chunks are weighted and averaged. This yields extremely smooth trajectory generation, avoiding the jitter common in frame-by-frame policies.

---
## Videos

### 1. Imitation Learning in action
<video src="videos/lerobot_video_2.mp4" controls playsinline width="50%"></video>

---
## Gallery

<div style="display: flex; flex-wrap: wrap; gap: 1rem; justify-content: center;">
  <img src="images/lerobot_2.jpg" alt="LeRobot 2" width="45%" />
  <img src="images/lerobot_3.jpg" alt="LeRobot 3" width="45%" />
  <img src="images/lerobot_4.jpg" alt="LeRobot 4" width="45%" />
  <img src="images/lerobot_5.jpg" alt="LeRobot 5" width="45%" />
</div>



