class MainMenuScene extends Scene {
    constructor() {
        super();

        this.playButton;
        this.trainButton;
        this.watchButton;
    }

    start() {
        super.start();
        this.playButton = createButton('Play');
        this.playButton.position(innerWidth/2-this.playButton.width/2, innerHeight/2 + 50);
        this.playButton.mousePressed(() => {
            this.sceneManager.openScene(PLAY_SCENE);
        });

        this.trainButton = createButton('Train');
        this.trainButton.position(innerWidth/2 - this.trainButton.width/2, innerHeight/2 + 100);
        this.trainButton.mousePressed(() => {
            this.sceneManager.openScene(TRAIN_SCENE);
        });

        this.watchButton = createButton('Watch Genius Bird');
        this.watchButton.position(innerWidth/2- this.watchButton.width/2, innerHeight/2 + 150);
        this.watchButton.mousePressed(() => {
            this.sceneManager.openScene(WATCH_SCENE);
        });
    }

    update() {
        super.update();
    }

    draw() {      
        background(0);
        fill(255);
        textSize(32);
        textAlign(CENTER, CENTER);
        text("Flappy Birds", width/2, height/2);
    }

    exit() {
        super.exit();
        this.playButton.remove();
        this.trainButton.remove();
        this.watchButton.remove();
    }

}