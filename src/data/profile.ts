import { FaLinkedin, FaRegIdBadge, FaGithub } from "react-icons/fa6";


export const UserInfo = {
    name: "Nevò Mirzai Hamadani",
    profile_url: "https://github.com/NevoMir.png",
    headline: "Student @ EPFL",
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
            url: "https://pm25.github.io/static/media/cv_v3.1ac3c71f.pdf",
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
        Hi! I’m Nevò, and I’m passionate about robotics, AI, and computer vision. I’m currently in the second year of my Master’s in Robotics at EPFL, where I’m also completing a minor in Data Science. I work on all kinds of interesting projects, from controlling swarms of drones with hand gestures to designing headlamps that follow your eyes. With a Bachelor’s degree in Mechanical Engineering, I developed a strong interest in how things move, and then discovered how powerful programming is for bringing them to life.
        <div class="my-2"></div>
        Outside of engineering, I enjoy judo, calisthenics, and running, which keep me energetic and inspired. Thanks for visiting! Feel free to <a href="mailto:nevo.mirzai@gmail.com" target="_blank" rel="noopener noreferrer">get in touch</a> if you'd like to connect.
    `
}
