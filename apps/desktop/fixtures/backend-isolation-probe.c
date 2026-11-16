#include <mach/mach.h>
#include <servers/bootstrap.h>
#include <stdio.h>

/* Observation only: obtain/release service ports, never read pixels/AX values or
 * post input. Check the actual kernel denial (not "service absent" or a timeout).
 * GUI APIs can hang after their required service is denied, so test at lookup.
 */
int main(void) {
  const char *services[] = {
    "com.apple.windowserver.active", "com.apple.axserver", "com.apple.replayd",
    "com.apple.tccd", "com.apple.coreservices.appleevents",
    "com.apple.coreservices.launchservicesd"
  };
  int denied = 1;
  for (unsigned i = 0; i < sizeof(services) / sizeof(services[0]); ++i) {
    mach_port_t port = MACH_PORT_NULL;
    kern_return_t result = bootstrap_look_up(bootstrap_port, services[i], &port);
    denied = denied && result == BOOTSTRAP_NOT_PRIVILEGED;
    if (port != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), port);
  }
  puts(denied ? "protectedServiceLookupsDenied=true" : "protectedServiceLookupsDenied=false");
  return denied ? 0 : 1;
}
