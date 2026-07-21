const getCurrentUserId = () => {
  let userId = null;
  BX24.callMethod("profile", {}, (result) => {
    if (result.error()) {
      console.error("Error fetching current user ID:", result.error());
    } else {
      userId = result.data().ID;
      console.log("Current user ID:", userId);
    }
  });

  return userId;
};

try {
  window.appPullClient = new BX.PullClient({
    restApplication: "dxbPaymentPlan.bitrix24.com",
    restClient: BX24,
    userId: getCurrentUserId(),
  });

  window.appPullClient.subscribe({
    moduleId: "application",
    callback: function (data) {
      console.log("PullClient callback received data:", data);
      console.warn(data);
    }.bind(this),
  });

  window.appPullClient.start();
} catch (e) {
  console.error("Error initializing PullClient:", e);
}
