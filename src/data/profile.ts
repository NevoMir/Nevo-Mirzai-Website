import {
    FaLinkedin,
    FaGoogleScholar,
    FaRegIdBadge,
    FaGithub,
    FaSquareFacebook,
} from "react-icons/fa6";


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
        Hi! I'm Nevò, and I'm passionate about (physical) AI, computer vision, and robotics. I'm currently in the second year of my Robotics Master at EPFL, where I work on all kind of interesting projects. With a bachelor in Mechanical Engineering, I've developed a strong interest in robotics systems, and have worked on projects like <i>[example project]</i> and <i>[another example]</i>, all centered around [what ties them together or your broader goal].
        <div class="my-2"></div>
        Outside of work, I enjoy Judo and running, which keep me grounded and spark new ideas. Thanks for visiting! Feel free to <a href="nevo.mirzai@gmail.com" target="_blank" rel="noopener noreferrer">get in touch</a> if you'd like to connect.
    `
}