// Populate the sidebar
//
// This is a script, and not included directly in the page, to control the total size of the book.
// The TOC contains an entry for each page, so if each page includes a copy of the TOC,
// the total size of the page becomes O(n**2).
class MDBookSidebarScrollbox extends HTMLElement {
    constructor() {
        super();
    }
    connectedCallback() {
        this.innerHTML = '<ol class="chapter"><li class="chapter-item expanded affix "><li class="part-title">Microduck官方文档</li><li class="chapter-item expanded "><a href="offical_docs/index.html"><strong aria-hidden="true">1.</strong> Readme</a></li><li class="chapter-item expanded "><a href="offical_docs/faq.html"><strong aria-hidden="true">2.</strong> FAQ</a></li><li class="chapter-item expanded "><a href="offical_docs/policy-manifest.html"><strong aria-hidden="true">3.</strong> Policy-manifest.md</a></li><li class="chapter-item expanded "><a href="offical_docs/recurrent-policies.html"><strong aria-hidden="true">4.</strong> Recurrent-polices.md</a></li><li class="chapter-item expanded "><a href="offical_docs/index.html"><strong aria-hidden="true">5.</strong> Design</a></li><li><ol class="section"><li class="chapter-item expanded "><a href="offical_docs/design/architecture.html"><strong aria-hidden="true">5.1.</strong> architecture.md</a></li><li class="chapter-item expanded "><a href="offical_docs/design/robotd-design.html"><strong aria-hidden="true">5.2.</strong> robotd-design.md</a></li><li class="chapter-item expanded "><a href="offical_docs/design/updater-design.html"><strong aria-hidden="true">5.3.</strong> updater-design.md</a></li><li class="chapter-item expanded "><a href="offical_docs/design/policy-channel-design.html"><strong aria-hidden="true">5.4.</strong> policy-channel-design.md</a></li><li class="chapter-item expanded "><a href="offical_docs/design/restart-order.html"><strong aria-hidden="true">5.5.</strong> restart-order.md</a></li><li class="chapter-item expanded "><a href="offical_docs/design/app-path-design.html"><strong aria-hidden="true">5.6.</strong> app-path-design.md</a></li><li class="chapter-item expanded "><a href="offical_docs/design/mobile-app.html"><strong aria-hidden="true">5.7.</strong> mobile-app.md</a></li><li class="chapter-item expanded "><a href="offical_docs/design/remote-access-design.html"><strong aria-hidden="true">5.8.</strong> remote-access-design.md</a></li><li class="chapter-item expanded "><a href="offical_docs/design/boot-recovery-net.html"><strong aria-hidden="true">5.9.</strong> boot-recovery-net.md</a></li><li class="chapter-item expanded "><a href="offical_docs/design/simulation.html"><strong aria-hidden="true">5.10.</strong> simulation.md</a></li><li class="chapter-item expanded "><a href="offical_docs/design/webrtc-console.html"><strong aria-hidden="true">5.11.</strong> webrtc-console.md</a></li></ol></li><li class="chapter-item expanded "><a href="offical_docs/index.html"><strong aria-hidden="true">6.</strong> Ideas</a></li><li><ol class="section"><li class="chapter-item expanded "><a href="offical_docs/ideas/autonomous_behavior.html"><strong aria-hidden="true">6.1.</strong> autonomous_behavior.md</a></li></ol></li><li class="chapter-item expanded "><a href="offical_docs/index.html"><strong aria-hidden="true">7.</strong> Project</a></li><li><ol class="section"><li class="chapter-item expanded "><a href="offical_docs/project/roadmap.html"><strong aria-hidden="true">7.1.</strong> roadmap.md</a></li><li class="chapter-item expanded "><a href="offical_docs/project/ci-setup.html"><strong aria-hidden="true">7.2.</strong> ci-setup.md</a></li><li class="chapter-item expanded "><a href="offical_docs/project/idle-cpu.html"><strong aria-hidden="true">7.3.</strong> idle-cpu.md</a></li><li class="chapter-item expanded "><a href="offical_docs/project/install-path-gap.html"><strong aria-hidden="true">7.4.</strong> install-path-gap.md</a></li><li class="chapter-item expanded "><a href="offical_docs/project/media-bringup.html"><strong aria-hidden="true">7.5.</strong> media-bringup.md</a></li><li class="chapter-item expanded "><a href="offical_docs/project/npu-bringup.html"><strong aria-hidden="true">7.6.</strong> npu-bringup.md</a></li><li class="chapter-item expanded "><a href="offical_docs/project/pad-minimal-pairing.html"><strong aria-hidden="true">7.7.</strong> pad-minimal-pairing.md</a></li><li class="chapter-item expanded "><a href="offical_docs/project/slice-2-bringup.html"><strong aria-hidden="true">7.8.</strong> slice-2-bringup.md</a></li><li class="chapter-item expanded "><a href="offical_docs/project/tof-on-demand.html"><strong aria-hidden="true">7.9.</strong> tof-on-demand.md</a></li><li class="chapter-item expanded "><a href="offical_docs/project/update-over-ble.html"><strong aria-hidden="true">7.10.</strong> update-over-ble.md</a></li></ol></li><li class="chapter-item expanded "><a href="offical_docs/index.html"><strong aria-hidden="true">8.</strong> Robot</a></li><li><ol class="section"><li class="chapter-item expanded "><a href="offical_docs/robot/cheatsheet.html"><strong aria-hidden="true">8.1.</strong> cheatsheet.md</a></li><li class="chapter-item expanded "><a href="offical_docs/robot/cheatsheet-dev.html"><strong aria-hidden="true">8.2.</strong> cheatsheet-dev.md</a></li><li class="chapter-item expanded "><a href="offical_docs/robot/dev-push.html"><strong aria-hidden="true">8.3.</strong> dev-push.md</a></li><li class="chapter-item expanded "><a href="offical_docs/robot/duckctl.html"><strong aria-hidden="true">8.4.</strong> duckctl.md</a></li><li class="chapter-item expanded "><a href="offical_docs/robot/install-by-hand.html"><strong aria-hidden="true">8.5.</strong> install-by-hand.md</a></li><li class="chapter-item expanded "><a href="offical_docs/robot/install-dev.html"><strong aria-hidden="true">8.6.</strong> intall-dev.md</a></li><li class="chapter-item expanded "><a href="offical_docs/robot/pair-a-gamepad.html"><strong aria-hidden="true">8.7.</strong> pair-a-gamepad.md</a></li><li class="chapter-item expanded "><a href="offical_docs/robot/simulation.html"><strong aria-hidden="true">8.8.</strong> simulation.md</a></li></ol></li></ol>';
        // Set the current, active page, and reveal it if it's hidden
        let current_page = document.location.href.toString().split("#")[0];
        if (current_page.endsWith("/")) {
            current_page += "index.html";
        }
        var links = Array.prototype.slice.call(this.querySelectorAll("a"));
        var l = links.length;
        for (var i = 0; i < l; ++i) {
            var link = links[i];
            var href = link.getAttribute("href");
            if (href && !href.startsWith("#") && !/^(?:[a-z+]+:)?\/\//.test(href)) {
                link.href = path_to_root + href;
            }
            // The "index" page is supposed to alias the first chapter in the book.
            if (link.href === current_page || (i === 0 && path_to_root === "" && current_page.endsWith("/index.html"))) {
                link.classList.add("active");
                var parent = link.parentElement;
                if (parent && parent.classList.contains("chapter-item")) {
                    parent.classList.add("expanded");
                }
                while (parent) {
                    if (parent.tagName === "LI" && parent.previousElementSibling) {
                        if (parent.previousElementSibling.classList.contains("chapter-item")) {
                            parent.previousElementSibling.classList.add("expanded");
                        }
                    }
                    parent = parent.parentElement;
                }
            }
        }
        // Track and set sidebar scroll position
        this.addEventListener('click', function(e) {
            if (e.target.tagName === 'A') {
                sessionStorage.setItem('sidebar-scroll', this.scrollTop);
            }
        }, { passive: true });
        var sidebarScrollTop = sessionStorage.getItem('sidebar-scroll');
        sessionStorage.removeItem('sidebar-scroll');
        if (sidebarScrollTop) {
            // preserve sidebar scroll position when navigating via links within sidebar
            this.scrollTop = sidebarScrollTop;
        } else {
            // scroll sidebar to current active section when navigating via "next/previous chapter" buttons
            var activeSection = document.querySelector('#sidebar .active');
            if (activeSection) {
                activeSection.scrollIntoView({ block: 'center' });
            }
        }
        // Toggle buttons
        var sidebarAnchorToggles = document.querySelectorAll('#sidebar a.toggle');
        function toggleSection(ev) {
            ev.currentTarget.parentElement.classList.toggle('expanded');
        }
        Array.from(sidebarAnchorToggles).forEach(function (el) {
            el.addEventListener('click', toggleSection);
        });
    }
}
window.customElements.define("mdbook-sidebar-scrollbox", MDBookSidebarScrollbox);
