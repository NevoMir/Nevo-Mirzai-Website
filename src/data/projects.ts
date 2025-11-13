export type ProjectResource = {
    type: "report" | "demo" | "slides";
    label: string;
    url?: string;
    description?: string;
};

export type Project = {
    slug: string;
    title: string;
    course?: string;
    timeline?: string;
    summary: string;
    description: string;
    highlights: string[];
    tags: string[];
    resources?: ProjectResource[];
    featured?: boolean;
    pdfLabel?: string;
    pdfDescription?: string;
};

export const ProjectsData: Project[] = [
    {
        slug: "ai-text-audio-hate-speech",
        title: "AI Text-Audio Model Training for Hate Speech Prediction",
        course: "Deep Learning",
        timeline: "2023",
        summary: "Fine-tuned a multimodal model that anticipates hate speech by fusing text and audio inputs.",
        description:
            "This project explored early detection of hate speech by combining acoustic cues with textual transcripts. We benchmarked different fusion strategies, optimized a custom training loop, and focused on minimizing false positives in sensitive conversations.",
        highlights: [
            "Fine-tuned a transformer backbone on curated contextual hate speech datasets.",
            "Designed a fusion layer that learns joint representations from audio spectrograms and transcripts.",
            "Performed error analyses to balance sensitivity with conversational nuance.",
        ],
        tags: ["Deep Learning", "Multimodal", "Responsible AI", "NLP"],
        resources: [
            {
                type: "report",
                label: "Final report (add PDF link)",
                description: "Attach the published report once available.",
            },
        ],
        featured: true,
    },
    {
        slug: "rl-quadruped-training",
        title: "Reinforcement Learning for a Quadruped Robot",
        course: "Legged Robots",
        timeline: "2023",
        summary: "Developed and tuned RL policies that stabilized a simulated quadruped across terrains.",
        description:
            "Focused on locomotion control inside OpenAI Gym, contrasting CPG-inspired controllers with policy gradients. Reward shaping and curriculum learning were iterated to achieve smooth gaits and fast convergence.",
        highlights: [
            "Implemented baseline CPG and Cartesian PID controllers for reference trajectories.",
            "Experimented with PPO and SAC, selecting hyperparameters for stability vs. speed.",
            "Crafted terrain-aware reward functions that favored energy-efficient steps.",
        ],
        tags: ["Reinforcement Learning", "Robotics", "Simulation"],
        resources: [
            {
                type: "report",
                label: "Training logbook",
                description: "Link the legged robot coursework notes.",
            },
        ],
        featured: true,
    },
    {
        slug: "inverse-rl-research",
        title: "Inverse RL Research",
        course: "Reinforcement Learning",
        timeline: "2024 (This semester)",
        summary: "Academic deep-dive into the limitations of popular inverse RL formulations.",
        description:
            "Surveyed MaxEnt IRL, adversarial approaches, and offline variants to propose practical heuristics that reduce demonstration requirements. Focused on reproducibility and lightweight evaluation harnesses.",
        highlights: [
            "Benchmarked state-of-the-art IRL libraries on shared control tasks.",
            "Documented common failure modes tied to reward misspecification.",
            "Outlined research directions for safer covariate shift handling.",
        ],
        tags: ["Research", "Inverse RL", "Reward Modeling"],
    },
    {
        slug: "chocolate-recognition",
        title: "Chocolate Recognition with Deep Learning",
        course: "Image Analysis",
        timeline: "2023",
        summary: "Built a convolutional pipeline to count chocolates under diverse backgrounds.",
        description:
            "Prepared a dataset of confectionery arrangements, applied aggressive augmentation, and trained a lightweight detector to separate overlapping sweets before counting instances.",
        highlights: [
            "Automated labeling with synthetic arrangements to extend limited data.",
            "Applied color constancy and histogram equalization for background invariance.",
            "Deployed the detector as a small Flask app for quick demos.",
        ],
        tags: ["Computer Vision", "Detection", "Automation"],
        resources: [
            {
                type: "report",
                label: "Lab report placeholder",
                description: "Drop the PDF once exported.",
            },
        ],
    },
    {
        slug: "robot-vision-navigation",
        title: "Computer Vision Navigation for a Robot",
        course: "Mobile Robotics",
        timeline: "2023",
        summary: "Implemented onboard vision and planning so a Thymio robot could reach goals autonomously.",
        description:
            "Combined OpenCV perception with particle filtering and A* planning to follow colored waypoints. Tuned closed-loop behavior for reliable on-table navigation.",
        highlights: [
            "Designed vision pipeline with color segmentation + morphological cleanup.",
            "Estimated robot pose via EKF and fused wheel odometry with visual beacons.",
            "Executed waypoint tracking with obstacle-aware path smoothing.",
        ],
        tags: ["Mobile Robotics", "OpenCV", "Navigation"],
        featured: true,
    },
    {
        slug: "autonomous-vehicle-mpc",
        title: "Autonomous Vehicle Navigation Using MPC",
        course: "Model Predictive Control",
        timeline: "2022",
        summary: "Implemented a simplified autonomous driving stack centered on MPC-based path tracking.",
        description:
            "Evaluated different MPC formulations, modeled vehicle dynamics, and developed a simulation harness to compare controllers under tight turns and obstacles.",
        highlights: [
            "Linearized bicycle model for predictive control under speed constraints.",
            "Benchmarked tracking error vs. compute budget for multiple solvers.",
            "Packaged the stack with visualization overlays for instructor demos.",
        ],
        tags: ["MPC", "Autonomous Driving", "Control"],
        featured: true,
    },
    {
        slug: "autonomous-drone-racing",
        title: "Autonomous Drone Racing",
        timeline: "2022",
        summary: "Programmed a Crazyflie drone to fly racing trajectories autonomously with onboard perception.",
        description:
            "Simulated laps with synthetic gates, applied computer vision for gate detection, and transferred motion primitives to hardware while accounting for aerodynamic drift.",
        highlights: [
            "Used ROS + Gazebo to validate trajectories before flight tests.",
            "Incorporated obstacle avoidance modules for pop-up barriers.",
            "Optimized PID gains for tight corners and altitude stability.",
        ],
        tags: ["Drones", "Computer Vision", "Autonomy"],
        resources: [
            {
                type: "demo",
                label: "Flight demo slot",
                description: "Embed the final race video here.",
            },
        ],
        featured: true,
    },
    {
        slug: "billiard-vision-analysis",
        title: "Billiard Game Analysis through Computer Vision",
        course: "Programming Project",
        timeline: "2021",
        summary: "Analyzed billiard dynamics in MATLAB, C, and LabVIEW to identify game outcomes.",
        description:
            "Captured match footage, processed ball trajectories, and extracted statistics to announce winners. Focused on portable tooling for sports analytics experiments.",
        highlights: [
            "Calibrated multi-camera setup and synchronized timestamps.",
            "Implemented collision detection and bounce classification.",
            "Automated scoreboard overlays driven by detection events.",
        ],
        tags: ["Computer Vision", "Signal Processing", "Sports Analytics"],
    },
    {
        slug: "hand-gesture-drone-swarms",
        title: "Hand Gesture Control for Drone Swarms with VR",
        timeline: "2024 (Ongoing)",
        summary: "Designing VR-based hand gesture interfaces that command coordinated drone swarms.",
        description:
            "Uses Meta Quest 3 controllers and dimensionality reduction to convert gestures into swarm formations. Integrates vision feedback and ML classifiers for intent recognition.",
        highlights: [
            "Streams skeletal data from VR hardware into a ROS pipeline.",
            "Explores PCA/U-MAP embeddings for low-latency gesture encoding.",
            "Fuses camera perception to validate formation execution.",
        ],
        tags: ["Human-Robot Interaction", "VR", "Swarm Robotics"],
        pdfLabel: "Final report",
        pdfDescription: "Aerial Swarm Hand Control write-up (PDF).",
        featured: true,
    },
    {
        slug: "carrots-peeler",
        title: "Mechanical Carrot Peeler — BA2 Project",
        course: "ME-102/107 Mechanical Construction",
        timeline: "2022",
        summary:
            "Designed and machined a fully manual carrot-peeling machine that synchronizes blade travel and carrot rotation with a single crank.",
        description:
            "As a BA2 team project we engineered a compact peeling machine that satisfies weight, safety, and manufacturability constraints. The mechanism uses twin fork supports, a chain-driven carriage, and a torsion-spring blade that adapts to irregular vegetables.",
        highlights: [
            "One crank simultaneously translates the blade and indexes the carrot 30° per turn.",
            "Torsion-spring blade mount maintains constant contact force without jamming.",
            "Complete machining package (drawings, CAM, BOM) delivered for 3-axis milling.",
        ],
        tags: ["Mechanical Design", "Product", "Manufacturing"],
    },
    {
        slug: "aerial-am",
        title: "Aerial Additive Manufacturing Prototype",
        timeline: "2024",
        summary:
            "Exploring drone-based additive manufacturing workflows that deposit material in flight for large-scale structures.",
        description:
            "Built an experimental setup where a multirotor carries a lightweight extrusion head and synchronized resin feed. The work focused on toolpath planning, material curing timing, and the control logic that keeps the nozzle aligned while the platform moves.",
        highlights: [
            "Implemented a dual-loop controller that couples flight dynamics with deposition rate.",
            "Validated toolpaths on curved mandrels and vertical surfaces without scaffolding.",
            "Packaged the workflow in ROS2 so future teams can iterate on materials and nozzle designs.",
        ],
        tags: ["Aerial Robotics", "Additive Manufacturing", "Research"],
    },
    {
        slug: "robotic-arm-scaffolding",
        title: "Robotic Arm Simulation for Scaffolding Applications",
        course: "Introduction to Robotics",
        timeline: "2022",
        summary: "Simulated inverse kinematics for a robotic arm that assists with scaffolding assembly.",
        description:
            "Modeled the construction environment in MATLAB, designed IK solvers, and validated real-time feasibility for Hong Kong building codes.",
        highlights: [
            "Built a kinematic chain model with joint limit enforcement.",
            "Integrated collision checking against scaffold elements.",
            "Demonstrated real-time control loops for assisted placement.",
        ],
        tags: ["Robotics", "IK", "Simulation"],
    },
    {
        slug: "quadcopter-design-stabilization",
        title: "Quadcopter Design and Stabilization",
        timeline: "2020",
        summary: "Designed, printed, and stabilized a quadcopter with custom PID loops.",
        description:
            "Produced CAD for the airframe, integrated IMU data, and tuned cascaded PID controllers to maintain hover despite lightweight frames.",
        highlights: [
            "3D printed structural components and optimized for weight.",
            "Developed embedded firmware in C++ for sensor fusion.",
            "Calibrated PID gains using thrust stand measurements.",
        ],
        tags: ["Drones", "Embedded Systems", "Control"],
    },
    {
        slug: "clickbait-data-analysis",
        title: "Clickbait Data Analysis",
        timeline: "2024 (This semester)",
        summary: "Investigated whether clickbait intent can be inferred from YouTube metadata.",
        description:
            "Used the Youniverse dataset to engineer behavioral features, trained ML classifiers, and evaluated interpretability for content teams.",
        highlights: [
            "Built a feature pipeline covering sentiment, timing, and creator history.",
            "Compared gradient boosting vs. lightweight neural approaches.",
            "Delivered dashboards that visualize false positive clusters.",
        ],
        tags: ["Data Science", "YouTube", "Classification"],
    },
    {
        slug: "data-augmentation-box",
        title: "Data Augmentation Box",
        timeline: "2024 (This semester)",
        summary: "Automated the photo capture process for object-recognition datasets using a custom rig.",
        description:
            "Constructed a rotating platform with controllable lighting and backgrounds, scripted camera capture, and paired it with YOLOv12 fine-tuning routines.",
        highlights: [
            "Engineered synchronized motors, lights, and cameras for repeatability.",
            "Implemented scripts that capture multi-angle sequences per object.",
            "Automated training/evaluation cycles for each new SKU.",
        ],
        tags: ["Hardware", "Automation", "Data Engineering"],
        resources: [
            {
                type: "report",
                label: "Assembly notes",
                description: "Attach BOM + wiring diagram when ready.",
            },
        ],
        featured: true,
    },
    {
        slug: "eye-tracker-headlamp",
        title: "Eye Tracker Headlamp",
        timeline: "2024 (This semester)",
        summary: "Built a gaze-aware headlamp that aligns light direction with the wearer’s line of sight.",
        description:
            "Combined an optical camera, IR camera, and dual servos driven by a Raspberry Pi 5 to keep the headlamp beam parallel to the detected gaze vector.",
        highlights: [
            "Implemented closed-loop control that corrects aim using camera feedback.",
            "Integrated servo drivers, power delivery, and safety interlocks.",
            "Optimized calibration so users can remap gaze in under a minute.",
        ],
        tags: ["Embedded Systems", "Computer Vision", "Human Factors"],
        resources: [
            {
                type: "report",
                label: "System design doc",
                description: "Link the full design specification once finalized.",
            },
        ],
    },
    {
        slug: "personal-website-simpleplain",
        title: "Personal Website Built on SimplePlain",
        timeline: "2025",
        summary: "Customized the SimplePlain template to showcase robotics work, interactive project pages, and inline media viewers.",
        description:
            "Cloned the SimplePlain template and transformed it into a tailored personal site with data-driven sections, immersive project detail routes, and horizontal media rails for reports, videos, and galleries.",
        highlights: [
            "Replaced GitHub auto-fetch with a curated CV-driven dataset for full control over messaging.",
            "Implemented inline PDF + media viewers optimized for 50% viewport height and horizontal scrolling.",
            "Extended routing to support slugged project pages with related-project carousels and responsive layout tweaks.",
        ],
        tags: ["Web", "React", "SimplePlain"],
        resources: [
            {
                type: "demo",
                label: "SimplePlain GitHub",
                url: "https://github.com/pm25/simpleplain",
                description: "Base template used as the starting point for this website.",
            },
        ],
    },
];

export const FeaturedProjects = ProjectsData.filter((project) => project.featured);
