function callBX(method, params) {
  return new Promise(function (resolve, reject) {
    BX24.callMethod(method, params, function (res) {
      if (res.error()) reject(res.error());
      else resolve(res.data());
    });
  });
}

async function getCurrentUserId() {
  const profile = await callBX("profile", {});
  return profile.ID;
}

(async () => {
  try {
    const userId = await getCurrentUserId();
    console.log("Current user ID:", userId);

    window.appPullClient = new BX.PullClient({
      restApplication: "dxbPaymentPlan.bitrix24.com",
      restClient: BX24,
      userId: userId,
    });

    window.appPullClient.subscribe({
      moduleId: "application",
      callback: function (data) {
        console.log("PullClient callback received data:", data);
        console.warn(data);
      },
    });

    window.appPullClient.start();
  } catch (e) {
    console.error("Error initializing PullClient:", e);
  }
})();
