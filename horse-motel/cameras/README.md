# Stall cameras: recommended setup

This setup is built to plug straight into the website. Nothing at the ranch is open to
the internet, and guests only ever see their own stall.

```
 BARN                                   RANCH HOUSE                        WEB SERVER (VPS)
 8 PoE dome cameras ──Cat6──► 8-port PoE NVR ──► Tailscale router ══ encrypted ══► MediaMTX ─► website
 (one per stall)              (records 24/7)     (no port forwarding)   tunnel      (HLS, localhost only)
```

**Why this design**
- **Power and data on one cable (PoE).** There are no outlets or Wi-Fi to fight with in a metal barn.
- **Each camera is streamed only while someone is watching.** One upload serves every viewer of that camera, which matters on a rural internet connection.
- **The NVR keeps recording locally**, and you still get the maker's phone app for yourself.

## Shopping list

| Item | Recommended | Why |
|---|---|---|
| Cameras (×8) | Reolink RLC-520A (5 MP PoE dome) or similar | Dome shape is hard for a horse to knock or chew. Infrared night vision (horses are watched most at night). IP66 dust/weather rating. **Sends H.264**, which browsers can play. RTSP support. |
| Recorder | Reolink RLN8-410 (8-channel NVR with 8 built-in PoE ports) | Cameras just plug in, with no separate PoE switch. Records 24/7. Gives an RTSP stream per camera. Often sold as a kit with cameras. |
| Barn ↔ house link | Outdoor / direct-burial Cat6 if the run is under 100 m (328 ft). Otherwise a pair of outdoor Wi-Fi bridges (e.g. TP-Link CPE210 or Ubiquiti NanoStation) | Gets the NVR's network to the house internet. |
| Secure tunnel | GL.iNet travel router with built-in Tailscale (e.g. GL-MT3000 "Beryl AX"). Alternative: a Raspberry Pi 5 running Tailscale | Lets the web server reach the NVR privately, with no port forwarding and nothing exposed. |
| Internet | At least 3–5 Mbps **upload** | Each camera being watched uses about 0.5 Mbps (low-bandwidth stream). |

Any camera or NVR that provides an **RTSP stream in H.264** works; the above is simply the easiest
known-good combination.

**Avoid:**
- **Cloud-only or battery/Wi-Fi cameras** (Ring, Blink, Arlo, Nest, Wyze): they don't give a stream the website can use.
- **Cameras that only send H.265**: browsers can't play it. Use the camera's H.264 "sub" stream if the main one is H.265.
- **Hikvision and Dahua gear**: US FCC restrictions.

## Mounting tips

- Mount each camera in a **high back corner of its stall** (8–9 ft), angled down across the stall to the door. That covers the whole stall and keeps it out of reach.
- Run the cable in **conduit** so it can't be chewed, and keep it clear of the stall fans (vibration blurs video).
- Don't aim infrared straight at the shiny steel grilles; glare washes out the night picture.
- Label each cable with its stall number and plug it into the **same-numbered NVR port**. Stall 3's camera goes on channel 3, so everything lines up automatically below.

## Installing: about an hour once the cameras are mounted

There are two halves. **You** do the ranch half, which is all plugging in and tapping
through apps. The **web-server half** is a few commands for whoever set up your website.
Hand them this page.

### Part 1: at the ranch (the owner)
1. **Cameras and recorder.**
   - Plug each camera into its NVR port and connect the NVR to a screen.
   - Finish the Reolink setup wizard with a strong admin password.
   - Turn **RTSP on**: *Settings → Network → Advanced → Port Settings*.
   - Create a second, **view-only** user for the website. Use a password made of **letters and numbers only**; symbols work, but are easier to get wrong.
2. **Tunnel router.** Plug the GL.iNet router's WAN port into your internet router, and connect the NVR to one of the GL.iNet's LAN ports.
3. **Give the recorder a fixed address.**
   - In the GL.iNet admin page, go to *Clients*, find the NVR, and choose **Reserve IP**. Otherwise a router restart can change its address and every stream stops.
   - Write that address down (e.g. `192.168.8.20`).
4. **Tailscale.**
   - In the GL.iNet admin page, go to *Applications → Tailscale*.
   - Sign in with a free Tailscale account and turn on **"Allow Remote Access LAN"**.
   - In the Tailscale admin console (login.tailscale.com), approve the router's **subnet route**.
5. Tip: put the NVR and GL.iNet router on a small **UPS** (battery backup) so a power blip doesn't take the cameras offline.

Send your website person: the recorder's address, the view-only user name and its password
(sent separately, e.g. in a text), and access to your Tailscale account.

### Part 2: on the web server (the website person, ~15 minutes)
1. **Join Tailscale:**
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up --accept-routes --advertise-tags=tag:web
   ```
   Then lock it down so **only** the web server can reach the ranch network, and only the recorder's video port. In the Tailscale admin console, *Access controls*, use a policy like this. Replace the subnet with the ranch one, e.g. `192.168.8.0/24`:
   ```json
   {
     "tagOwners": { "tag:web": ["autogroup:admin"] },
     "acls": [ { "action": "accept", "src": ["tag:web"], "dst": ["192.168.8.0/24:554"] } ]
   }
   ```
2. **Install MediaMTX with the guided script.** From the website folder:
   ```bash
   sudo bash cameras/install.sh
   ```
   It downloads MediaMTX (x86-64 or ARM), asks for the recorder's address, user and password, and writes `/etc/mediamtx.yml`. That file is readable only by the site's user, and symbols in the password are encoded for you. It then starts the service and checks stall 1.

   Prefer to do it by hand? Download `mediamtx_<version>_linux_amd64.tar.gz` (or `_arm64`) from https://github.com/bluenviron/mediamtx/releases. Unpack it with `tar -xzf`, then use `cameras/mediamtx.yml` and `cameras/mediamtx.service`; instructions are at the top of each.
3. **Add the cameras to the site.** In `.env`, set `CAMERA_ALLOWED_HOSTS=127.0.0.1` and restart the site. Then run:
   ```bash
   npm run cameras:setup
   ```
   This adds "Stall 1 camera" … "Stall 8 camera", each mapped to its stall. The camera addresses are stored encrypted.
4. **Check each camera** in **Admin → Cameras → Test**. Each one should play within a few seconds.

That's it. When a guest books stall 3, they can watch "Stall 3 camera", and only that camera,
from a few hours before check-in until a few hours after check-out. The defaults are 3 and 2
hours; they're set by `CAMERA_HOURS_BEFORE_CHECKIN` / `CAMERA_HOURS_AFTER_CHECKOUT`.

## If a camera won't play

| What you see | Fix |
|---|---|
| "The camera isn't responding" | Is the NVR on, at the same reserved address? Is Tailscale connected on both ends (`tailscale status` on the server)? `journalctl -u mediamtx -n 50` shows the reason. |
| "This camera's video format can't be played" | The camera is sending H.265. In the Reolink app set that channel's encoding to H.264, or keep the `_sub` stream in `mediamtx.yml`. |
| Picture is choppy | Your upload is too slow. Stay on the `_sub` stream, or lower the sub-stream frame rate to 10–15 fps in the NVR settings. |
| Test works but a guest sees nothing | Check that the camera is ticked against the right stall in Admin → Cameras, and that their stay is in its viewing window. |

Already have cameras? Any system that can give an RTSP (or HLS) stream in H.264 will work. Use its
RTSP address in `mediamtx.yml` in place of the Reolink ones.
