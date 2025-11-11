# Hand Gesture Control for Drone Swarms with VR

This journal-style log captures the weekly progress while prototyping the VR interface that commands the Crazyflie swarm. It mirrors the same storytelling experience used in the “Deep Learning with Keras” article so future projects can follow the exact workflow.

## Goals

- Stream skeletal data from the Meta Quest 3 controllers.
- Learn a gesture-to-formation mapping that supports quick demos.
- Validate intent through the onboard vision system before committing the swarm.

## Dataset & Tooling

- Recordings collected inside the EPFL flying arena.
- Gesture feature extraction handled by a small Python/NumPy notebook.
- Training notebooks shared internally (ask for `gesture-notebook.ipynb`).

## Slides

<div class="relative w-full max-w-4xl aspect-video mx-auto overflow-hidden rounded-md my-6">
    <iframe
        class="absolute top-0 left-0 w-full h-full"
        src="https://docs.google.com/presentation/d/e/2PACX-1vS3tKpe7iTEPnwJ6kuCPf7NlfHIfOc3pWKTW4FfISy5jr2mq2bSIlGTWU3X3KHk9T8AgCZhSNOy6juS/embed?start=false&loop=false&delayms=10000"
        allowfullscreen
        title="Hand Gesture Swarm Deck"
    ></iframe>
</div>

## Next Steps

1. Add an out-of-distribution detector before sending commands to the drones.
2. Bring the new ROS2 drivers upstream so the rest of the team can pilot quickly.
3. Continue collecting gestures for collaborative patterns (i.e., multi-swarm choreographies).
