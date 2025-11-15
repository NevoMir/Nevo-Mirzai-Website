# Evolutionary Robotics — Quadruped Locomotion and Stair Climbing  
2024 • *From animal-inspired gaits to DRL stair climbing on a quadruped robot.*

---

## Overview

This project explores how to make a quadruped robot **walk, trot and climb stairs** by combining:

- **Central Pattern Generators (CPGs)** – bio-inspired oscillators that generate rhythmic leg motions (gaits),  
- **PD control** – to track desired joint or foot positions,  
- **Deep Reinforcement Learning (DRL)** – to learn more complex behaviours such as climbing stairs.

In the first part, we designed CPGs for four gaits (TROT, WALK, PACE, BOUND), tuned their parameters, and analyzed:

- gait stability at different speeds,  
- duty cycle (time on ground vs in the air),  
- energy efficiency via **Cost of Transport (CoT)**.

In the second part, we used **PPO**-based DRL with PD motor control in a **STAIRS** environment. We carefully designed the observation space and a multi-term reward function so that the robot learns to:

- move forward,  
- stay roughly straight,  
- and climb a staircase without falling.

The main takeaway: **CPGs + PD** give smooth, efficient gaits on flat terrain; **DRL + PD** can handle stairs, but with more jerky motions and higher energy cost.

---

## Central Pattern Generators (CPGs)

### Gaits and CPG parameters

We implemented four gaits using a CPG network:

- **TROT** – diagonal legs synchronized (front-left with rear-right, and vice versa).  
- **WALK** – legs move in sequence with at least two on the ground.  
- **PACE** – left pair and right pair move together.  
- **BOUND** – front legs together, rear legs together.

Each leg has an oscillator with:

- **phase** $\theta$ and its derivative $\dot{\theta}$ (controls timing of swing/stance),  
- **amplitude** $r$ (controls step size).

For the TROT gait at medium speed, the CPG parameters look like this:

<img src="Images_CPG/opti plot/Cpg prmt opti speed.png" alt="CPG parameters for TROT medium speed" width="80%" />

- The green curve is the phase $\theta$.  
- The slope change around $\theta = \pi$ marks **swing vs stance**.  
- $\dot{\theta}$ jumps between two values:  
  - $\omega_{\text{swing}}$ when the leg is in the air,  
  - $\omega_{\text{stance}}$ when the leg is on the ground.  
- The phase offsets between legs define the **gait pattern** (trot, walk, etc.).

### Amplitude convergence and the role of $\alpha$

The amplitude $r$ does not start at its final value; it converges quickly at the beginning of the simulation.  
The convergence speed is controlled by a factor $\alpha$:

- larger $\alpha$ → faster convergence,  
- smaller $\alpha$ → slower, smoother start.

Below we compare amplitude convergence for two values of $\alpha$ for the TROT gait:

<div style="display:flex; gap:1rem; flex-wrap:wrap;">
  <img src="Images_CPG/amplitude_cvg_alpha30.png" alt="Amplitude convergence alpha 30" width="47%" />
  <img src="Images_CPG/amplitude_cvg_alpha50.png" alt="Amplitude convergence alpha 50" width="47%" />
</div>

With $\alpha = 50$ the amplitude stabilizes much faster than with $\alpha = 30$, which is good for quickly reaching a steady gait, but can produce a more abrupt start.

### Tracking with joint PD vs Cartesian PD

To track the CPG-based trajectories we tested:

- **Joint PD control** – PD on each joint angle,  
- **Cartesian PD control** – PD on desired foot position in space,  
- **Joint PD + Cartesian PD** – joint PD as the main term, Cartesian PD as a small correction.

For the TROT gait at medium speed, the desired vs actual **foot position** with all controllers combined looks as follows:

<img src="Images_CPG/new plot trot/trot foot pos pd cpd .png" alt="Foot position with joint PD + Cartesian PD" width="70%" />

Similarly, for **joint angles**:

<img src="Images_CPG/opti plot/joint angle opti speed pd et cpd.png" alt="Joint angles with joint PD + Cartesian PD" width="70%" />

What we observed:

- The behaviour with **joint PD only** and **joint PD + Cartesian PD** is very similar.  
- Cartesian PD alone looks “good” in some plots, but often this is because the robot has already **fallen**, so tracking is easy but meaningless.  
- In practice, **joint PD** carries most of the control, and Cartesian PD is useful only as a small fine-tuning term.

### Tuning PD gains

For TROT at medium speed, a typical set of joint PD gains was:

- $K_p = [200,\ 150,\ 150]$ for hip, thigh, knee,  
- $K_d = [5,\ 5,\ 5]$ for all three joints.

Raising $K_p$ improves tracking but can make the robot unstable; raising $K_d$ makes it more stable but can make it slower and less responsive.  
We found gains mostly by **visual inspection**: run a simulation, watch if it stays upright and follows the CPG, then adjust.

### Hyperparameters and duty cycle

We tuned many CPG and control parameters per gait:

- $\omega_{\text{swing}}$, $\omega_{\text{stance}}$ – swing vs stance frequencies,  
- $\mu$ – amplitude (step height / length),  
- desired step length – sets average forward speed,  
- convergence factor $\alpha$,  
- coupling strength between oscillators,  
- ground clearance / penetration,  
- PD gains.

For the TROT gait, we measured **duty cycle**:

$$
\text{Duty Cycle} = \frac{\text{Stance Duration}}{\text{Stride Duration}}
$$

At **maximum speed**, stance time is shorter and duty cycle is low (around 0.41), meaning the legs spend less time on the ground.  
At **minimum speed**, stance time is longer and duty cycle increases (around 0.66), which gives more stability but less speed.

We used these values to check that our tuned gaits remain physically reasonable and similar to animal-like behaviour.

### Cost of Transport (CoT) and efficiency

To compare energy use across gaits we used the **Cost of Transport**:

$$
\text{CoT} = \frac{E}{m g d}
$$

where:

- $E$ = total energy used,  
- $m g$ = robot weight,  
- $d$ = distance traveled.

Key observations (using the last 8 s of simulation, when motion has stabilized):

- At **max speed**, CoT is always lower than at **min speed** because $d$ is much larger.  
- **TROT** and **WALK** were our most optimized gaits and showed **reasonable CoT**.  
- **PACE** and **BOUND** were less tuned and had much higher CoT, especially at low speed.  
- By increasing joint $K_d$ for WALK (from 2.7 to 5) while keeping other parameters constant, we reduced CoT from about **0.69 to 0.29**, at the cost of slightly lower speed but much better efficiency.

In simple words: for our CPGs, **fast but stable gaits** (especially TROT and WALK) turned out to be **more energy-efficient** than trying to walk very slowly.

---

## Deep Reinforcement Learning for Stair Climbing

### Control mode and environments

For DRL we tested two motor modes:

- **CPG motor control mode** – CPG generates trajectories, RL adjusts them; used successfully on **SLOPE**.  
- **Joint PD motor control mode** – RL outputs desired joint positions; PD tracks them.  

For the **STAIRS** environment (our main challenge), we chose **PD control mode**:

- CPGs give very nice, smooth motion but are less natural for stairs.  
- PD control allowed more **direct adaptation** to step edges and irregular heights.

We trained the robot in two steps:

1. Flat terrain with a simple forward-locomotion reward.  
2. STAIRS environment with a more complex reward designed for stair climbing.

### Observation space

We started from the standard observation space (joint angles, joint velocities, base orientation), then extended it to a custom mode `LR_COURSE_OBS` that adds:

- **Contact information**:  
  - which feet are in contact,  
  - contact forces,  
  - valid/invalid contact counts.  
- **Orientation details**: roll, pitch, yaw, useful for balance on stairs.  
- **CPG states** ($r, \dot{r}, \theta, \dot{\theta}$) when using the CPG-based DRL variant.

We also **standardized** the observations (so all features have comparable scale), which helps the network learn more evenly from all signals.

### Reward design

The reward function is the heart of training. We composed it from several terms:

1. **Velocity tracking** – rewards matching a desired forward speed:  

   $$
   R_{\text{velocity}} = 0.35 \cdot \exp\left(-\frac{(\text{desired\_}\nu_x - \text{current\_}\nu_x)^2}{0.1}\right) - 0.03
   $$

2. **Progress** – rewards forward progress along $x$ regardless of speed profile:  

   $$
   R_{\text{progress}} = 10 \cdot (x_t - x_{t-1})
   $$

3. **Yaw tracking** – keeps the robot facing forward:  

   $$
   R_{\text{yaw}} = 0.1 \cdot \exp\left(-\frac{(\text{desired\_yaw} - \text{current\_yaw})^2}{0.25}\right)
   $$

4. **Smoothness** – penalizes sudden changes in joint angles, velocities and contact forces (used carefully; too much smoothness made stairs harder).

5. **Drift penalty** – discourages lateral deviation from the center line:

   $$
   R_{\text{drift}} = -0.05 \cdot |y|
   $$

6. **Oscillation penalty** – discourages unrealistic oscillations in motor velocities, based on how often their sign changes.

Most terms follow the same **“revised Gaussian”** shape:

$$
R(x) = a \cdot \exp\left(-\frac{(b - x)^2}{c}\right) + d
$$

This gives:

- a high reward when the robot is close to the desired value $b$,  
- still some reward when it is nearby,  
- negative offset $d$ so that staying far from the goal for a long time leads to a net penalty.

We used tools like **GeoGebra** to tune these curves:

<img src="Images_RL/Geogebra_velocity_function.png" alt="Geogebra velocity function" width="100%" />

We adjusted weights by trial and error and by looking at how reward components behaved during successful vs unsuccessful runs.

An example of how the different reward terms compare in a trained run:

<img src="Images_RL/reward_comparison_exemple.png" alt="Reward comparison" width="100%" />

### PPO algorithm and network

We used **Proximal Policy Optimization (PPO)** from Stable Baselines3:

- **On-policy**: uses fresh batches of data, no replay buffer.  
- **Clipped updates**: prevents the policy from changing too much at once (clip range = 0.2).  
- Well suited to our setup where data collection is straightforward.

The policy and value networks are both simple **MLPs**:

- 2 hidden layers,  
- 256 units each,  
- non-linearities between layers.

Important hyperparameters:

- **Learning rate**: started around $1 \cdot 10^{-4}$ and decreased in later runs as we increased difficulty (higher stairs).  
- **n_steps = 4096**: number of time steps collected before each update.  
- **Gamma = 0.99**: discount factor, encouraging the agent to care about long-term rewards (smooth, continuous climbing).  

### Training curriculum and environments

We focused on the **STAIRS** environment:

- Episode length: between **15 and 20 seconds** depending on the run, long enough to let the robot:
  - fail and reset, **or**
  - recover after a bad start and still climb.

We used an **“adaptive terrain curriculum”**:

- start with lower, easier stairs (0.03 m),  
- then increase stair height (0.04 m, 0.05 m),  
- re-train for a few million steps each time (2–3M),  
- also vary the number of steps in the staircase.

This helped the robot progressively adapt rather than face hard stairs from the beginning.

### Learning curves and behaviour

Below are two examples of learning curves (total reward over training steps):

<img src="Images_RL/early_stage.jpg" alt="Early learning stage" width="100%" />

- In the early stage, we see **fast improvement** as the robot learns basic forward motion and a first rough stair-climbing policy.

<img src="Images_RL/fine_tunning.jpg" alt="Fine-tuning stage" width="100%" />

- In the fine-tuning stage, reward grows more slowly while the robot learns to handle higher stairs and more precise behaviour.

Qualitatively:

- The robot **can climb stairs** without falling in many episodes.  
- It can sometimes **recover** after tripping or bumping into a step and continue climbing.  
- It generally stays near the center line thanks to the drift penalty and yaw reward.

However:

- Movements with PD control are often **jerky and energy-consuming** compared to CPG-based gaits.  
- The **Cost of Transport** is high (values around 3), and motion is not very animal-like.  
- Transferring this policy to real hardware would be challenging: sudden speed changes could damage motors or be hard to reproduce.

---

## Conclusion

This project combined **bio-inspired CPGs** and **Deep Reinforcement Learning** to study quadruped locomotion:

- With **CPGs + PD**, we built and tuned four gaits (TROT, WALK, PACE, BOUND), analyzed stability, duty cycle and energy cost, and showed that trot and walk can be both **fast and reasonably efficient** when parameters are carefully adjusted.  
- With **DRL + PD** in the **STAIRS** environment, we designed a rich observation space and a multi-part reward function that allowed the robot to **learn to climb stairs** despite noisy PD behaviour and complex contact patterns.

From this, we learned:

- CPGs are excellent for **smooth, repeatable gaits** on flat terrain and simple slopes.  
- DRL is powerful for **task-specific adaptation** (stairs), but requires careful reward shaping and can easily trade natural movement for “whatever works”.  
- The next step would be to combine both ideas: use CPGs as a structured prior and let RL refine them, while also focusing more on **energy efficiency** and **simulation-to-reality transfer**.