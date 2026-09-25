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

### At the ranch (no computer skills needed)
1. **Cameras and NVR.** Plug each camera into its NVR port and connect the NVR to a screen. Finish the Reolink setup wizard: set a strong password, and in *Settings → Network → Advanced → Port Settings* make sure **RTSP is on**.
2. **Tunnel router.** Plug the GL.iNet router's WAN port into your internet router, and connect the NVR to the GL.iNet's LAN port.
3. **Tailscale.** In the GL.iNet admin page, go to *Applications → Tailscale*. Sign in with a free Tailscale account and turn on **"Allow Remote Access LAN"**.
4. **Approve the route.** In the Tailscale admin console, approve the router's subnet route. Note the NVR's IP address (shown on the GL.iNet's client list, e.g. `192.168.8.20`).

### On the web server (one time)
1. **Join Tailscale:** `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up --accept-routes`.
   - The server can now reach the NVR privately. In the Tailscale admin console, add an ACL rule so only the server can reach the ranch network.
2. **Install MediaMTX:**
   - Download the `linux_amd64` release from https://github.com/bluenviron/mediamtx/releases.
   - Copy `cameras/mediamtx.yml` to `/etc/mediamtx.yml`.
   - Replace `NVR_IP`, `NVR_USER` and `NVR_PASSWORD` in that file. Use a separate NVR user with view-only rights.
   - Install `cameras/mediamtx.service` (instructions are at the top of that file).
   - MediaMTX listens on `127.0.0.1` only.
3. **Point the site at MediaMTX.** In `.env`, set `CAMERA_ALLOWED_HOSTS=127.0.0.1`, then run:
   ```bash
   npm run cameras:setup
   ```
   This adds "Stall 1 camera" … "Stall 8 camera", each mapped to its stall. The camera addresses are stored encrypted.
4. **Check each camera.** Go to **Admin → Cameras → Test**. Each one should play within a few seconds.

That's it. When a guest books stall 3, they can watch "Stall 3 camera", and only that camera, from
3 hours before check-in until 2 hours after check-out.

## If a camera won't play

| What you see | Fix |
|---|---|
| "The camera isn't responding" | Is the NVR on? Is Tailscale connected on both ends (`tailscale status` on the server)? |
| "This camera's video format can't be played" | The camera is sending H.265. In the Reolink app set that channel's encoding to H.264, or keep the `_sub` stream in `mediamtx.yml`. |
| Picture is choppy | Your upload is too slow. Stay on the `_sub` stream, or lower the sub-stream frame rate to 10–15 fps in the NVR settings. |
| Test works but a guest sees nothing | Check that the camera is ticked against the right stall in Admin → Cameras, and that their stay is in its viewing window. |

Already have cameras? Any system that can give an RTSP (or HLS) stream in H.264 will work. Use its
RTSP address in `mediamtx.yml` in place of the Reolink ones.
