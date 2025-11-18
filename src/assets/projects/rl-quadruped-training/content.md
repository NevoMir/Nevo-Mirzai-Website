# Evolutionary robotics

**2024 – Improving quadruped quadruped locomotion on stairs using CPGs and deep reinforcement learning**

<video src="cover/cover.mp4" controls autoplay muted loop playsinline height="50vh"></video>

---

<!--
<img src="Images_CPG/opti plot/Cpg prmt opti speed.png"
     alt="CPG parameters for TROT gait at medium speed"
     height="60vh">
-->

<!--
<img src="Images_CPG/Cpg prm/MAX_WALK_CPG_parameters.png"
     alt="CPG parameters for WALK gait at maximum speed"
     height="60vh">
-->

<!--
<img src="Images_CPG/plots with PD +CPD/cpg prmt max speed trot.png"
     alt="TROT CPG parameters at max speed, used to derive duty cycle"
     height="60vh">
-->

<!--
<img src="Images_RL/reward_comparison_exemple.png"
     alt="Comparison of individual reward terms during training"
     height="60vh">
-->

<!--
<img src="Images_RL/reward_comparison_hight_stairs.jpg"
     alt="Reward evolution while climbing a tall staircase"
     height="60vh">
-->

---

## Project overview

In this project we explored how to make a **simulated quadruped robot** walk robustly on flat terrain and then **climb stairs**, by combining two ideas:

- **Central Pattern Generators (CPGs)** – bio-inspired oscillators that produce rhythmic leg motions (gaits).
- **Deep Reinforcement Learning (DRL)** – a neural network policy that learns how to adapt those motions to difficult terrain like stairs.

The work builds on the code framework from the EPFL course **MICRO-507 “Legged Robots”**, and extends it with new gaits, controllers, reward functions and training curricula.

---

## Central Pattern Generators (CPGs)

First, we focused on **clean, hand-designed locomotion** using CPGs:

- We implemented four standard quadruped gaits:
  - **TROT** – diagonal legs synchronized.
  - **WALK** – at least two legs always on the ground.
  - **PACE** – left/right sides move together.
  - **BOUND** – front legs together, rear legs together.
- Each leg’s motion is driven by an oscillator with:
  - **phase** \(\theta\) and its derivative \(\dot{\theta}\),
  - **amplitude** \(\mu\),
  - different frequencies in **swing** (leg in the air) and **stance** (leg on the ground).

By tuning CPG parameters like:
- swing/stance frequencies \(\omega_{\text{swing}}, \omega_{\text{stance}}\),
- amplitude \(\mu\),
- ground clearance / penetration,
- desired step length,
- coupling strength between legs,

we obtained **stable gaits at both low and high speeds**.

To track the desired foot trajectories, we used:

- **Joint-space PD control** (for each hip, thigh and knee joint)  
- plus a lighter **Cartesian PD** controller (on foot position) as a fine correction.

In practice, **joint PD does most of the work**, and Cartesian PD slightly improves tracking when the robot is still upright.

We also measured:

- **Duty cycle** (fraction of time the foot is on the ground), which changes between slow and fast trot.
- **Cost of Transport (CoT)** for each gait:
  - TROT and WALK can be tuned to be relatively efficient.
  - PACE and BOUND were not optimized as much and show higher CoT.
  - Increasing joint derivative gains \(K_D\) in WALK reduced CoT significantly by smoothing motion and reducing wasted oscillations.

This CPG part gives us **well-understood, repeatable gaits** that work well on flat terrain and gentle slopes.

---

## Deep Reinforcement Learning for stair climbing

Flat terrain is one thing; **stairs are much harder**. The robot must:

- place its feet precisely,
- manage body orientation,
- and recover from small slips or impacts.

For this, we used **Deep Reinforcement Learning** with:

- **Action space:**  
  - **PD joint control** of the 12 motors (desired joint positions), rather than CPG-only control.  
  - CPG-based motor control was used successfully in the SLOPE environment, but for stairs we preferred the flexibility of direct PD joint commands.

- **Observation space:** starting from joint angles, velocities, and orientation, and extending with:
  - **contact information** (which feet are in contact, contact forces),
  - additional **orientation parameters** for body posture,
  - and, in CPG-based experiments, the CPG internal states \((r, \dot{r}, \theta, \dot{\theta})\).

This richer observation helps the policy “understand” where the body and feet are with respect to the stairs.

---

## Reward design

The behaviour of the learned policy is almost entirely driven by the **reward function**. We combined several terms:

- **Forward velocity reward** – encourages moving at a desired speed in the x direction.
- **Progress reward** – directly rewards increasing forward position, regardless of exact speed profile.
- **Yaw alignment reward** – keeps the robot facing forward, aligned with the stairs.
- **Drift penalty** – penalizes lateral deviation in y, to avoid the robot sliding sideways.
- **Smoothness penalty** – discourages very abrupt changes in joint angles/velocities/forces (used carefully, because too much smoothness made stairs harder).
- **Oscillation penalty** – penalizes “crazy” back-and-forth joint velocity patterns, calibrated from the clean CPG gaits.

Most of these rewards have a **Gaussian-like shape**:  
high reward near the desired value, but still slightly positive for small deviations. A negative offset makes sure that doing nothing (or being very far from the target) is penalized.

We tuned these shapes and weights iteratively, often by plotting them (e.g. in GeoGebra) and checking how they behave for typical values.

---

## RL algorithm and training setup

We used **Proximal Policy Optimization (PPO)** (from Stable-Baselines3):

- **On-policy**, stable, relatively simple to tune.
- Policy and value networks are **MLPs with two hidden layers of 256 units**.
- Key hyperparameters:
  - learning rate starting around \(1 \times 10^{-4}\), gradually reduced as we increased task difficulty,
  - \(n\_steps = 4096\) (rollout length),
  - clipping range \(= 0.2\),
  - discount factor \(\gamma = 0.99\) for smooth, long-term behaviour.

For the **environment**:

- We mainly trained in the **STAIRS** environment.
- Episode length: ~15–20 seconds, long enough for several attempts to climb.
- We used a simple **curriculum**:
  - start with **smaller steps** (e.g. 0.03 m),
  - then retrain / fine-tune with **higher steps** (0.04 m, 0.05 m),
  - also vary number of steps to improve robustness.

Training runs used a few **million timesteps** per configuration.

---

## Results and limitations

What we observed:

- With **CPG only**, the robot has very clean, animal-like gaits on flat ground and slopes, with reasonable energy efficiency.
- With **DRL + PD control** on stairs:
  - the robot learns to **climb a staircase** without falling, even with higher steps,
  - it can **recover from small disturbances**, e.g. tripping on a step and then re-aligning,
  - the motion that emerges is **effective but not very natural**:
    - lots of quick, sometimes jerky movements,
    - relatively **high Cost of Transport** (around ~3 in typical runs).

The policy is therefore **good at solving the specific task (climb these stairs)**, but:

- it may not transfer easily to real hardware without further work  
  (safety, motor limits, more realistic contact/friction modelling),
- and it is not yet optimized for **smoothness or energy**.

---

## Takeaways

This project shows how two approaches complement each other:

- **CPGs + PD** give:
  - interpretable parameters,
  - clean gaits,
  - good performance on well-understood terrains.

- **Deep RL + PD** gives:
  - the ability to **adapt** to complex, discontinuous environments like stairs,
  - but at the cost of less interpretable behaviour and higher energy use.

A natural next step would be to **combine both more tightly**:  
use CPGs to generate a robust “default” gait and let RL learn only small corrections for tricky terrain, ideally leading to controllers that are **both efficient and highly adaptable**.