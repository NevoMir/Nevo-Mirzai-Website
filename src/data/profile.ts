import { FaLinkedin, FaRegIdBadge, FaGithub } from "react-icons/fa6";
import { RESUME_URL } from "@/data/config";


export const UserInfo = {
    name: "Nevò Mirzai Hamadani",
    profile_url: "https://github.com/NevoMir.png",
    headline: "Intern @ EAI\u00A0\u00A0|\u00A0\u00A0Student @ EPFL",
    email: "nevo.mirzai@gmail.com",
    links: [
        {
            name: "LinkedIn",
            url: "https://www.linkedin.com/in/nev%C3%B2-mirzai-hamadani-0b2a21300/",
            icon: FaLinkedin,
        },
        // {
        //     name: "Google Scholar",
        //     url: "https://scholar.google.com.tw/citations?user=nQdpH2MAAAAJ",
        //     icon: FaGoogleScholar,
        // },
        {
            name: "Résumé",
            url: RESUME_URL,
            icon: FaRegIdBadge,
        },
        {
            name: "Github",
            url: "https://github.com/NevoMir",
            icon: FaGithub,
        },
        // {
        //     name: "Facebook",
        //     url: "https://www.facebook.com/pyhuang97",
        //     icon: FaSquareFacebook,
        // },
    ],
    // you can use HTML syntax here (e.g. <br/>, <a>, <strong>, ...)
    biography: `
        Hi! I’m Nevò, and I’m passionate about Robotics, Simulation, Neural Networks and Computer Vision. Currently I'm interning at Embodied AI, a startup focused on the development of humanoid robots, where my work centers on the teleoperation stack. I am pursuing a Master's in Robotics at EPFL with a minor in Data Science, where I have served as Teaching Assistant across multiple courses and led the simulation team in the EPFL Rocket Team, focusing on vertical landing simulation. I worked on all kinds of interesting projects, from controlling swarms of drones with hand gestures to designing headlamps that track your eyes. With a BSc in Mechanical Engineering, I developed a strong interest in how things move, and then discovered how powerful programming is for bringing them to life.
        <div class="my-2"></div>
        Outside of engineering, I enjoy judo, calisthenics, and running, which keep me energetic and ready to tackle new problems. Thanks for visiting! Feel free to <a href="mailto:nevo.mirzai@gmail.com" target="_blank" rel="noopener noreferrer">get in touch</a> if you'd like to connect.
    `
}
