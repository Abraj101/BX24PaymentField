try {
  window.appPullClient = new BX.PullClient({
    restApplication: "dxbPaymentPlan.bitrix24.com",
    restClient: BX24,
    userId: 1,
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
