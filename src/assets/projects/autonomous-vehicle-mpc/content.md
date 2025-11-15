# MPC-Based Autonomous Car Control  
2024 • *Model Predictive Control for cruising, lane keeping, and overtaking.*

<img src="Figures/Del_6_2/overtake3.pdf" alt="Nonlinear MPC overtaking maneuver" height="55vh" />

---

## Overview

In this project I explored how to **model, linearize and control a car** using several flavors of **Model Predictive Control (MPC)**:

- Start from a **bicycle model** of a car with position, heading and speed.
- **Linearize** the model around highway driving and split it into:
  - a **longitudinal** subsystem (speed and $x$-position),
  - a **lateral** subsystem (lane position $y$ and heading $\theta$).
- Design **linear MPC** controllers for each subsystem with constraints on:
  - throttle and steering,
  - lane boundaries and maximum heading.
- Add an **offset-free observer** to remove steady-state errors due to disturbances.
- Build a **robust tube MPC** for **adaptive cruise control (ACC)**, where the lead car is treated as a bounded disturbance.
- Finally, switch to a **nonlinear MPC (NMPC)** that uses the full non-linear model to perform **smooth overtaking with collision avoidance**.

Along the way, I tuned cost weights, horizons and terminal sets, and used simulation to check comfort, constraint satisfaction and robustness.

---

## Vehicle model and linearization

### Nonlinear bicycle model

The car is modeled with a simple **bicycle model** with 4 states and 2 inputs:

- State  
  $$
  x = \begin{bmatrix} x & y & \theta & V \end{bmatrix}^T
  $$
  where:
  - $x, y$: position of the car’s center of mass in world coordinates,  
  - $\theta$: heading angle,
  - $V$: forward speed.

- Inputs  
  $$
  u = \begin{bmatrix} \delta & u_T \end{bmatrix}^T
  $$
  where:
  - $\delta$: steering angle,
  - $u_T$: throttle command (normalized).

With a slip angle $\beta$ and standard longitudinal forces, the dynamics are:

$$
\dot x = f(x,u) =
\begin{bmatrix}
V\cos(\theta + \beta) \\
V\sin(\theta + \beta) \\
\dfrac{V}{l_r}\sin(\beta) \\
\dfrac{F_{\text{motor}} - F_{\text{drag}} - F_{\text{roll}}}{m}
\end{bmatrix}
$$

I linearize this model around **straight-line highway driving**:

- steady speed $V_s$,
- zero steering $\delta_s = 0$ (so $\beta_s = 0$),
- heading $\theta_s = 0$.

Using a first-order Taylor expansion:

$$
f(x,u) \approx f(x_s,u_s) + A(x - x_s) + B(u - u_s)
$$

where

$$
A = \left.\frac{\partial f}{\partial x}\right|_{(x_s,u_s)}, 
\quad
B = \left.\frac{\partial f}{\partial u}\right|_{(x_s,u_s)}.
$$

In this operating point, the $A$ and $B$ matrices get a nice structure:  
- the **longitudinal dynamics** depend mainly on $V$ and $u_T$,  
- the **lateral dynamics** depend mainly on $y$, $\theta$ and $\delta$.  

This makes it natural to split the car into two almost independent subsystems.

---

## Splitting into longitudinal and lateral subsystems

### Longitudinal subsystem

States and input:

- states: forward position and speed $(x, V)$,  
- input: throttle $u_T$.

Here the dynamics are dominated by engine force, drag and rolling resistance. Steering has essentially **no effect** on these states in the linearized model. So longitudinal MPC can focus on:

- tracking a **speed reference** (e.g. 120 km/h),
- respecting **throttle limits**:
  $$
  -1 \le u_T \le 1
  $$

with no explicit constraint on $x$ (position along the road).

### Lateral subsystem

States and input:

- states: lateral position and heading $(y, \theta)$,  
- input: steering angle $\delta$.

Here steering is the key input, and throttle does not directly affect $y$ or $\theta$ in the linear model. I impose:

- steering constraint:
  $$
  |\delta| \le 30^\circ = 0.5236 \ \text{rad}
  $$
- lane and comfort constraints:
  $$
  -0.5\,\text{m} \le y \le 3.5\,\text{m}, \quad
  |\theta| \le 5^\circ = 0.0873\ \text{rad}
  $$

These can be written as:

$$
Mu \le m, \quad Fx \le f
$$

so they fit nicely into the MPC formulation.

---

## Linear MPC for lane keeping and lane change

### MPC optimization problem

For both subsystems I use a standard **finite-horizon quadratic MPC**:

$$
J = \sum_{i=0}^{N-1}
\left[(x_i - x_{\text{ref}})^T Q (x_i - x_{\text{ref}}) +
(u_i - u_{\text{ref}})^T R (u_i - u_{\text{ref}})\right]
+ J_{\text{terminal}}
$$

subject to:

- discrete linear dynamics,
- input and state constraints,
- a **terminal set** and **terminal cost** derived from LQR.

The terminal cost is:

$$
J_{\text{terminal}} = (x_N - x_{\text{ref}})^T P (x_N - x_{\text{ref}})
$$

where $P$ comes from the Discrete Algebraic Riccati Equation, and the terminal feedback is:

$$
u = K_f x.
$$

The **terminal set** $\mathcal{X}_f = \{x \mid F_f x \le f_f\}$ is chosen so that:

- it is **invariant** under $u = K_f x$,
- all constraints are respected forever if $x \in \mathcal{X}_f$.

This guarantees **recursive feasibility** and closed-loop stability.

<img src="Figures/Del_3_1/Terminal_Set_Lat31.eps" alt="Terminal invariant set for lateral subsystem" width="60%" />

### Tuning and results

- Longitudinal MPC:
  - $Q = 25$ (penalizes speed error only),
  - $R = 0.5$ (keeps throttle smooth).
- Lateral MPC:
  - $Q = \begin{bmatrix} 5 & 0 \\ 0 & 20 \end{bmatrix}$ for $(y,\theta)$,
  - $R = 25$ for steering.

With these weights:

- the car reaches **120 km/h in under 7 s**,  
- a full **lane change in about 1.5 s**,  
- all input and state constraints are respected.

<img src="Figures/Del_3_1/Velocity.pdf" alt="Longitudinal MPC velocity tracking" width="48%" />
<img src="Figures/Del_3_1/Y_pos_Heading.pdf" alt="Lateral MPC lane change and heading" width="48%" />

---

## Offset-free tracking with a disturbance observer

Even with a good model, unmodeled effects (drag errors, slopes, etc.) can create a small **steady-state error** in speed. To fix this, I:

1. **Augment the state** with a constant disturbance $d$:
   $$
   \hat z = \begin{bmatrix} V \\ d \end{bmatrix}
   $$
2. Write extended dynamics:
   $$
   \hat z_{k+1} = \hat x_s + \hat A(\hat z_k - \hat x_s) + \hat B(u_k - \hat u_s)
   $$
   where the disturbance state $d$ is modeled as constant.
3. Design an **observer**:
   $$
   \hat z_{k+1} = \hat x_s + \hat A(\hat z_k - \hat x_s) + \hat B(u_k - \hat u_s) + L(\hat C \hat z_k - y_k)
   $$
   with poles chosen at $0.75$ and $0.9$ for a good compromise between speed and robustness.

Then I feed the estimated disturbance back into the MPC, so the controller compensates it automatically. This produces **offset-free tracking**: the final speed error is on the order of a few $10^{-3}$ km/h or less.

<img src="Figures/Del_4_1/Velocity.pdf" alt="Offset-free MPC velocity tracking" width="48%" />
<img src="Figures/Del_4_1/Disturbance.pdf" alt="Estimated disturbance over time" width="48%" />

---

## Robust tube MPC for Adaptive Cruise Control (ACC)

Now the ego car follows a **lead car** on the same lane. The goal is to:

- keep a **safe distance** (at least 6 m),
- match the lead car’s speed,
- be robust to unknown lead-car acceleration/braking within bounds.

### Idea: “tube” around a nominal trajectory

We treat the lead car as a **bounded disturbance** on the ego car’s longitudinal dynamics. The lead throttle $\tilde u_T$ is assumed to stay in a known interval:

$$
\tilde u_T \in [u_{T,s} - 0.5,\ u_{T,s} + 0.5]
$$

This defines a **disturbance set** $\mathcal W$ propagated through the input matrix $B_d$. We then:

1. Compute the **minimum robust invariant set** $\mathcal E$ for the error dynamics under a stabilizing feedback $K$:
   $$
   x_{k+1} = (A_d - B_d K)x_k + w_k,\quad w_k \in \mathcal W.
   $$
2. Tighten the state constraints:
   $$
   \tilde{\mathbb{X}} = \mathbb{X} \ominus \mathcal E
   $$
3. Tighten the input constraints:
   $$
   \tilde{\mathbb{U}} = \mathbb{U} \ominus K\mathcal E
   $$
4. Solve MPC on the **nominal system** using the tightened sets. The real trajectories stay within a “tube” of radius $\mathcal E$ around the nominal trajectory.

<img src="Figures/Del_5_1/ego_following_lead_illustration.pdf" alt="Ego car following lead car" width="70%" />

<img src="Figures/Del_5_1/MinInvSet_Epsilon_5_1.eps" alt="Minimal robust invariant set E" width="48%" />
<img src="Figures/Del_5_1/TermSet_Xf_5_1.eps" alt="Terminal set Xf under tightened constraints" width="48%" />

The main safety constraint is:

$$
\tilde x - x \ge 6\ \text{m}
$$

and we choose a slightly larger “safety target” (e.g. 8 m) so that even with disturbances the ego car stays above 6 m.

### ACC results

For both constant and varying lead-car throttle:

- the ego car **never gets closer than 6 m**,  
- it accelerates or brakes to match the lead car,  
- throttle can be somewhat aggressive (trade-off between comfort and tight following).

Examples:

<img src="Figures/Del_5_1/Velocity_varyingLead.pdf" alt="ACC ego speed with varying lead" width="48%" />
<img src="Figures/Del_5_1/RelativeDistance_varyingLead.pdf" alt="ACC relative distance to lead car" width="48%" />

---

## Nonlinear MPC for lane change and overtaking

Linear MPC works well around one operating point, but for **large maneuvers** like overtaking at different speeds it is better to use the **full nonlinear model**.

### NMPC setup

I implement a **Nonlinear MPC** in CasADi:

- same state $x = [x, y, \theta, V]^T$, input $u = [\delta, u_T]^T$,
- dynamics integrated with **4th-order Runge–Kutta (RK4)** at each time step,
- horizon $H \approx 10$ s, discretized into $N$ steps.

Constraints:

- $-1 \le u_T \le 1$,
- $|\delta| \le 30^\circ$,
- lane and heading limits as before,
- dynamics enforced by:
  $$
  X_{k+1} = f_{\text{discrete}}(X_k, U_k).
  $$

### Cost function and offset-free speed

For simple lane-change tracking:

$$
Q = \text{diag}(0,\ 1,\ 1,\ 1), \quad
R = \text{diag}(2000,\ 1).
$$

- No cost on $x$ (forward position),
- strong penalty on steering changes (comfort),
- moderate penalty on $y$, $\theta$, $V$ deviations.

To get **almost zero steady-state speed error**, I add a **reference throttle** $u_{T,\text{ref}}$ to the cost:

Instead of penalizing $\|U_k\|_R^2$ I penalize:

$$
(U_k - [0,\ u_{T,\text{ref}}]^T)^T R (U_k - [0,\ u_{T,\text{ref}}]^T).
$$

This pushes the throttle towards the value needed to keep $V$ at $V_{\text{ref}}$. With this trick, the residual speed error drops from around $10^{-3}$ km/h to something on the order of $10^{-10}$ km/h (essentially numerical noise).

### Smoother steering via rate constraints

To avoid sudden steering at the start of lane changes, I also constrain the **rate of change** of steering:

$$
-0.001 \le U(1,k) - U(1,k-1) \le 0.001
$$

This keeps steering transitions smooth and removes sharp corners in the $y$-trajectory.

<img src="Figures/Del_6_1/Velocity.pdf" alt="NMPC velocity tracking with Ut_ref" width="48%" />
<img src="Figures/Del_6_1/Steering.pdf" alt="NMPC steering with rate constraint" width="48%" />

---

## Nonlinear MPC for safe overtaking

For overtaking, I extend NMPC to include the **lead car state** $x_{\text{other}}$:

- The lead car is assumed to move at (roughly) constant speed (e.g. 80 km/h).  
- The ego car must **avoid collision**, **change lane**, overtake, then **come back**.

### Elliptical safety zone

I define an **elliptical “keep-out” region** around the lead car:

$$
(X_k - X_{\text{other},k})^T
H_{\text{const}}
(X_k - X_{\text{other},k})
\ge 1
$$

with

$$
H_{\text{const}} = \text{diag}\left(\frac{1}{d_x^2},\ \frac{1}{d_y^2}\right).
$$

- $d_y = 3$ m (roughly one lane width),
- $d_x = 15$ m (safety distance in front/behind).

This means: as long as the ego car stays outside this ellipse in $(x,y)$, it is at a safe distance.

### Final NMPC design for overtaking

For this task I use:

- cost weights:
  $$
  Q = \text{diag}(0,\ 1,\ 1,\ 300),\quad
  R = \text{diag}(60,\ 1),
  $$
- a slightly looser steering-rate constraint:
  $$
  -0.01 \le U(1,k) - U(1,k-1) \le 0.01
  $$

This keeps the motion **smooth** but allows enough steering to complete the overtake.

Comparison of steering with/without the steering-rate constraint:

<img src="Figures/Del_6_2/Steering_overtake_without_addition.pdf" alt="Steering during overtaking without rate constraint" width="48%" />
<img src="Figures/Del_6_2/Steering_overtake.pdf" alt="Steering during overtaking with rate constraint" width="48%" />

### Overtaking behavior

Snapshots of the maneuver:

<img src="Figures/Del_6_2/overtake1.pdf" alt="Overtake step 1" width="40%" />
<img src="Figures/Del_6_2/overtake3.pdf" alt="Overtake step 3" width="40%" />

Final trajectories:

<img src="Figures/Del_6_2/Velocity_overtake.pdf" alt="Velocity during overtaking" width="48%" />
<img src="Figures/Del_6_2/Y_pos_overtake.pdf" alt="Lateral position during overtaking" width="48%" />

<img src="Figures/Del_6_2/Throttle_overtake.pdf" alt="Throttle during overtaking" width="48%" />
<img src="Figures/Del_6_2/Relative_distance_overtake.pdf" alt="Relative distance to lead car during overtaking" width="48%" />

The ego car:

- accelerates smoothly to pass the lead car,
- changes lane without sharp steering,
- maintains a safe elliptical distance,
- returns to the original lane and stabilizes at the desired speed with almost zero offset.

---

## What this project shows

Putting everything together:

- **Linear MPC** is great for **separate** speed and lane controllers, with clear guarantees on constraints and stability.
- An **offset-free observer** makes tracking robust against unknown constant disturbances.
- **Tube MPC** provides **robust ACC**, guaranteeing a minimum distance to the lead car even if it accelerates/brakes within a known range.
- **Nonlinear MPC** can handle full-range driving maneuvers like **overtaking**, combining:
  - the full nonlinear model,
  - collision avoidance,
  - comfort via steering-rate and input penalties,
  - and almost perfect speed tracking.

Overall, the project is a small “toolbox” of MPC techniques for autonomous driving: from simple cruising and lane keeping to robust following and overtaking.