# Mechanical Carrot Peeler  
2022 • *A fully manual, safe, and precise carrot-peeling machine designed from scratch.*

---

## Overview

This project was carried out as part of the **Mechanical Construction (ME-102/107)** course at EPFL.  
The objective was to design and build a **domestic carrot-peeler** that:

- peels carrots along their full length,  
- adapts to diameters between **20–45 mm**,  
- runs **fully manually** (one hand on a crank),  
- stays **under 8 kg**,  
- and remains **safe, reliable, and easy to clean**.

Our final design uses:

- **Two rotating fork supports** that hold and rotate the carrot,  
- A **chain-driven blade module** sliding along the carrot,  
- A **manual crank** driving both the blade movement and the carrot rotation,  
- A **torsion-spring blade support** to adapt to carrot irregularities,  
- A mechanical layout fully machinable on a **3-axis mill**.

In short:  

> One crank turn makes the blade move along the carrot **and** rotates the carrot slightly. After 12 turns, the carrot is fully peeled.

---

## Pictures / Media

### Complete machine  
<img src="images/carrot-machine-full.jpg" height="50vh" />

### Basic idea (stylized sketch)  
<img src="images/carrot-machine-idea.jpg" height="50vh" />

### Example of 2D machining drawing  
<img src="images/carrot-drawing-2d.jpg" height="50vh" />

### Mounting / assembly detail  
<img src="images/carrot-mounting-example.jpg" height="50vh" />

---

## How the mechanism works

### 1. Clamping and rotating the carrot

The carrot is held between **two stainless-steel fork supports**:

- One fork sits on a sliding shaft and can move forward/backward to match carrot length.  
- A **tightening lever** squeezes the sliding shaft inside a conical hole to lock the carrot securely.  
- A ball bearing between fork and shaft allows **free rotation**.  
- The second fork is fixed in rotation but not in translation.

Once clamped, the carrot has **one desired motion**: rotation around its main axis.

---

## 2. The manual crank drives everything

Turning the crank performs two synchronized actions:

**(1) Blade movement (translation)**  
The crank turns a conical gear → pulley → belt → sprocket → chain.  
This chain pulls the blade along the full length of the carrot.

**(2) Carrot rotation**  
The same crank also turns a conical gear with a **1-to-12 reduction ratio**, so:
- **1 full crank rotation → carrot rotates 30°**  
- **12 crank turns → full 360° rotation**

This number comes from experimentation:  
We measured that the carrot requires **~12 cuts** to remove the whole external layer.

So the machine ensures:
- For every pass of the blade, the carrot rotates just enough so the next slice is adjacent to the previous one.

This makes the peeling **repeatable** and guarantees no part of the carrot is missed.

---

## 3. The chain-mounted blade and its flexible support

The blade needs to:

- stay in contact with irregular carrot surfaces,  
- apply a roughly constant cutting force,  
- avoid jamming,  
- and allow easy cleaning.

To achieve this, the blade is mounted on the chain using a **torsion-spring assembly**:

- Two torsion springs allow the blade to rotate very slightly around its support axis.  
- This gives a **self-adjusting** motion: the blade pushes into the carrot with the correct force while absorbing bumps.  
- A small ramp in the support improves initial contact so the blade doesn’t “dig in” abruptly.

This system was chosen after testing other options (compression springs, multi-chain supports) which either jammed or required excessive force.

---

## 4. The key calculations that guided the design

We experimentally measured:

- **Force needed to peel the carrot**: about **8–12 N**  
- **Number of cuts needed**: **12**

This gave us:

### Required blade power  
With a blade speed of about **0.4 m/s**:

$$P_\text{blade} = F \cdot v = 11.5 \text{ N} \cdot 0.4 \text{ m/s} \approx 4.6 \text{ W}$$

Then we accounted for losses in each transmission stage:

| Component | Efficiency |
|----------|------------|
| Chain | 0.97 |
| Sprockets | 0.98 |
| Pulleys | 0.98 |
| Belt | 0.95 |
| Conical gears | 0.98 |

Multiplying these together gives the overall efficiency **η ≈ 0.87**, so:

$$P_\text{input} = \frac{P_\text{blade}}{\eta} \approx 5.38 \text{ W}$$

This is the power the **user** must supply through the crank.

### Required manual force  
With crank radius **r = 0.1 m** and angular speed **ω = 2π rad/s** (one turn per second):

$$F = \frac{P}{r \cdot \omega} \approx \frac{5.38}{0.1 \cdot 2\pi} \approx 8.56 \text{ N}$$

This corresponds to pushing with less than **1 kg**, which fits the specification for a single-hand user-powered system.

### Blade pressure via torsion spring  
We needed a **normal force ≥ 8 N** on the carrot for consistent peeling.  
Using supplier data for the torsion spring:

$$F = \frac{M_{\max}}{\ell_r} \cdot \frac{\alpha}{\alpha_{\max}}$$

Solving gave a required preload angle of **≈ 43°**, which we integrated in the design.

All material choices (POM-C, aluminium, stainless steel) were verified using stress and torsion formulas with safety factors ≥ 2.

---

## Final result

The final carrot-peeling machine:

- Weighs **≈ 6.5 kg** (under the 8 kg limit)  
- Peels carrots smoothly with only a **light manual effort**  
- Adapts automatically to irregular shapes  
- Can be disassembled and cleaned easily  
- Uses only parts machinable with **3-axis milling**  
- Is safe, stable, and robust

A simple hand-crank operates a surprisingly elegant mechanical system where **geometry, forces, and motion were all carefully balanced** to achieve an efficient and reliable peeling process.